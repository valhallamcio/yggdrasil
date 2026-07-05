import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import { Writer } from '../src/plugins/biforesting-link/frame-codec.ts';
import { decodeQuestReg } from '../src/plugins/biforesting-link/decoders.ts';

/** questreg wire: [varint ver=1][varint gzLen][gz utf8-json] — mirrors shared QuestRegistryPayloads. */

function envelope(json: unknown): Buffer {
  const gz = gzipSync(Buffer.from(JSON.stringify(json), 'utf8'));
  const w = new Writer().varInt(1).varInt(gz.length);
  return Buffer.concat([w.build(), gz]);
}

test('questreg codec: envelope gunzips to source + quest rows', () => {
  const payload = envelope({
    source: 'ftbq',
    count: 2,
    quests: [
      {
        id: '00000000000001A4',
        chapter: '1',
        chapterTitle: 'Getting Started',
        title: 'Craft a Furnace',
        subtitle: 'smelt things',
        taskCount: 2,
        tasks: ['ItemTask', 'CheckmarkTask'],
      },
      { id: '42', chapter: '', chapterTitle: '', title: 'BQ quest', subtitle: '', taskCount: 0, tasks: [] },
    ],
  });

  const reg = decodeQuestReg(payload);
  assert.equal(reg.source, 'ftbq');
  assert.equal(reg.count, 2);
  assert.equal(reg.quests.length, 2);
  assert.equal(reg.quests[0]?.id, '00000000000001A4');
  assert.equal(reg.quests[0]?.chapterTitle, 'Getting Started');
  assert.equal(reg.quests[0]?.title, 'Craft a Furnace');
  assert.equal(reg.quests[0]?.taskCount, 2);
  assert.deepEqual(reg.quests[0]?.tasks, ['ItemTask', 'CheckmarkTask']);
  assert.equal(reg.quests[1]?.title, 'BQ quest');
});

test('questreg codec: rows without an id are dropped, malformed fields default', () => {
  const payload = envelope({
    source: 'bq',
    quests: [
      { id: '7', title: 'kept' },
      { title: 'no id — dropped' },
      { id: '', title: 'empty id — dropped' },
    ],
  });
  const reg = decodeQuestReg(payload);
  assert.equal(reg.quests.length, 1);
  assert.equal(reg.quests[0]?.id, '7');
  assert.equal(reg.quests[0]?.chapterTitle, '', 'missing string fields default to empty');
  assert.equal(reg.quests[0]?.taskCount, 0);
  assert.equal(reg.count, 1, 'count falls back to surviving row count when absent');
});

test('questreg codec: unsupported version and truncated gz are rejected', () => {
  const bad = new Writer().varInt(2).varInt(0).build();
  assert.throws(() => decodeQuestReg(bad), /unsupported questreg version/);

  const truncated = new Writer().varInt(1).varInt(10).build();
  assert.throws(() => decodeQuestReg(truncated), /exceeds payload/);
});
