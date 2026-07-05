import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { decodeItemRegistry } from '../src/plugins/biforesting-link/decoders.ts';
import { Writer } from '../src/plugins/biforesting-link/frame-codec.ts';

/** Item registry wire: v2 = [varint 2][varint gzLen][gz utf8-json]; v1 = [varint 1][count][{id}{num}]. */

function v2(obj: Record<string, unknown>): Buffer {
  const gz = gzipSync(Buffer.from(JSON.stringify(obj), 'utf8'));
  const w = new Writer().varInt(2).varInt(gz.length);
  return Buffer.concat([w.build(), gz]);
}

test('itemreg codec: v2 envelope gunzips to items with variants + complete flag', () => {
  const payload = v2({
    source: 'forge-1.7',
    count: 2,
    complete: false,
    stats: { enumerated: 2, failed: 5 },
    items: [
      { id: 'minecraft:stone', mod: 'minecraft', display: 'Stone', maxStack: 64 },
      {
        id: 'gregtech:gt.metaitem.01',
        num: 4097,
        mod: 'gregtech',
        display: 'Meta Item',
        maxStack: 64,
        variants: [{ meta: 32001, display: 'Copper Dust' }, { meta: 32002, display: 'Tin Dust' }],
      },
    ],
  });
  const reg = decodeItemRegistry(payload);
  assert.equal(reg.version, 2);
  assert.equal(reg.source, 'forge-1.7');
  assert.equal(reg.complete, false, 'best-effort 1.7.10 dump');
  assert.equal(reg.count, 2);
  assert.equal(reg.stats?.failed, 5);

  assert.equal(reg.items[0]?.id, 'minecraft:stone');
  assert.equal(reg.items[0]?.num, 0, 'num defaults to 0 when absent (modern)');
  assert.deepEqual(reg.items[0]?.variants, []);

  const gt = reg.items[1]!;
  assert.equal(gt.num, 4097);
  assert.equal(gt.mod, 'gregtech');
  assert.equal(gt.variants.length, 2);
  assert.equal(gt.variants[0]?.meta, 32001);
  assert.equal(gt.variants[0]?.display, 'Copper Dust');
});

test('itemreg codec: complete defaults to true, mod is derived from the id namespace', () => {
  const reg = decodeItemRegistry(v2({
    source: 'modern',
    count: 1,
    items: [{ id: 'create:cogwheel', display: 'Cogwheel', maxStack: 64 }], // no mod field
  }));
  assert.equal(reg.complete, true, 'complete defaults true when omitted');
  assert.equal(reg.items[0]?.mod, 'create', 'mod derived from id namespace');
});

test('itemreg codec: rows without an id are dropped', () => {
  const reg = decodeItemRegistry(v2({
    source: 'modern',
    count: 3,
    items: [
      { id: 'minecraft:stone', display: 'Stone', maxStack: 64 },
      { display: 'no id', maxStack: 1 },
      { id: '', display: 'empty id', maxStack: 1 },
    ],
  }));
  assert.equal(reg.items.length, 1);
  assert.equal(reg.items[0]?.id, 'minecraft:stone');
});

test('itemreg codec: v1 payload decodes into the same shape (id→num, empty display)', () => {
  // v1: [varint 1][varint count][{utf id}{varint num}]…
  const w = new Writer().varInt(1).varInt(2).utf('minecraft:dirt').varInt(9).utf('create:cogwheel').varInt(7777);
  const reg = decodeItemRegistry(w.build());
  assert.equal(reg.version, 1);
  assert.equal(reg.source, 'legacy');
  assert.equal(reg.complete, true);
  assert.equal(reg.items.length, 2);
  assert.equal(reg.items[0]?.id, 'minecraft:dirt');
  assert.equal(reg.items[0]?.num, 9);
  assert.equal(reg.items[0]?.mod, 'minecraft');
  assert.equal(reg.items[0]?.display, '');
  assert.equal(reg.items[1]?.num, 7777);
});

test('itemreg codec: an unsupported version throws', () => {
  const w = new Writer().varInt(99);
  assert.throws(() => decodeItemRegistry(w.build()), /unsupported registry version 99/);
});
