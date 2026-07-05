import '../helpers/env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestMongo, type TestMongo } from '../helpers/mongo.ts';
import { setPackLangDbProvider, savePackLang } from '../../src/plugins/biforesting-link/pack-lang-store.ts';
import {
  setQuestRegDbProvider,
  saveQuestRegistry,
  searchQuests,
  questRegistryInfo,
} from '../../src/plugins/biforesting-link/quest-registry-store.ts';
import type { LinkIdentity, QuestRegPayload, QuestRegRow } from '../../src/plugins/biforesting-link/types.ts';

let mongo: TestMongo;
const DB = 'ygg_questreg_test';

function identity(instanceKey: string): LinkIdentity {
  return { linkServerId: instanceKey, tag: instanceKey, instanceKey, name: instanceKey, resolved: true } as LinkIdentity;
}

function quest(id: string, title: string, extra: Partial<QuestRegRow> = {}): QuestRegRow {
  return { id, chapter: '', chapterTitle: '', title, subtitle: '', taskCount: 0, tasks: [], ...extra };
}

function payload(source: string, quests: QuestRegRow[]): QuestRegPayload {
  return { source, count: quests.length, quests };
}

before(async () => {
  mongo = await startTestMongo();
  setQuestRegDbProvider(() => mongo.client.db(DB));
  setPackLangDbProvider(() => mongo.client.db(DB));
});
after(async () => mongo.stop());

test('questreg-store: dump persists rows and a re-dump replaces the whole instance registry', async () => {
  await saveQuestRegistry(identity('pack-a'), payload('ftbq', [
    quest('1A4', 'Craft a Furnace', { chapterTitle: 'Getting Started', subtitle: 'smelt things', taskCount: 2, tasks: ['ItemTask'] }),
    quest('1A5', 'Removed Later'),
  ]));

  let info = await questRegistryInfo('pack-a');
  assert.equal(info.count, 2);
  assert.equal(info.source, 'ftbq');
  assert.ok(info.dumpedAt);

  // re-dump: 1A5 vanished from the pack, 1A6 appeared — the dump is authoritative
  await saveQuestRegistry(identity('pack-a'), payload('ftbq', [
    quest('1A4', 'Craft a Furnace'),
    quest('1A6', 'Brand New'),
  ]));
  info = await questRegistryInfo('pack-a');
  assert.equal(info.count, 2, 'replaced, not appended');
  assert.equal((await searchQuests('pack-a', 'Removed Later')).length, 0, 'deleted quest is gone');
  assert.equal((await searchQuests('pack-a', 'Brand New'))[0]?.questId, '1A6');
});

test('questreg-store: search resolves exact id, text words, and partial substrings', async () => {
  await saveQuestRegistry(identity('pack-s'), payload('bq', [
    quest('100', 'Better Grass Starting Out', { chapterTitle: 'Basics' }),
    quest('200', 'Advanced Circuits', { subtitle: 'LV to HV' }),
    quest('300', 'Grass Block Mastery'),
  ]));

  // exact questId wins even when it would text-match nothing
  const byId = await searchQuests('pack-s', '200');
  assert.equal(byId.length, 1);
  assert.equal(byId[0]?.title, 'Advanced Circuits');

  // $text word search, multiple hits
  const grass = await searchQuests('pack-s', 'grass');
  assert.equal(grass.length, 2);

  // partial word falls back to substring regex ($text can't match 'circ')
  const partial = await searchQuests('pack-s', 'circ');
  assert.equal(partial.length, 1);
  assert.equal(partial[0]?.questId, '200');

  // subtitle + chapterTitle are searchable too
  assert.equal((await searchQuests('pack-s', 'Basics'))[0]?.questId, '100');
  assert.equal((await searchQuests('pack-s', 'HV'))[0]?.questId, '200');

  // no search string lists the registry
  assert.equal((await searchQuests('pack-s', undefined)).length, 3);
});

test('questreg-store: uploaded pack lang resolves lang-key titles at ingest (R2, nomifactory BQ)', async () => {
  // nomifactory ships BQ titles as lang KEYS (client-only lang) — a raw dump stores the keys
  await savePackLang('nomi', {
    'nomifactory.quest.5.title': 'Getting Started',
    'nomifactory.quest.5.subtitle': 'Punch a tree',
  });
  await saveQuestRegistry(identity('nomi'), payload('bq', [
    quest('5', 'nomifactory.quest.5.title', { subtitle: 'nomifactory.quest.5.subtitle' }),
    quest('6', 'Already English'), // untouched
  ]));

  const byWord = await searchQuests('nomi', 'Getting Started');
  assert.equal(byWord[0]?.questId, '5', 'lang-key title resolved and searchable');
  const byId = await searchQuests('nomi', '5');
  assert.equal(byId[0]?.title, 'Getting Started', 'stored title is the resolved text');
  assert.equal(byId[0]?.subtitle, 'Punch a tree');
  assert.equal((await searchQuests('nomi', '6'))[0]?.title, 'Already English', 'non-key title untouched');
});

test('questreg-store: instances are isolated', async () => {
  await saveQuestRegistry(identity('pack-x'), payload('ftbq', [quest('1', 'Only In X')]));
  await saveQuestRegistry(identity('pack-y'), payload('bq', [quest('1', 'Only In Y')]));
  assert.equal((await searchQuests('pack-x', 'Only'))[0]?.title, 'Only In X');
  assert.equal((await searchQuests('pack-y', 'Only'))[0]?.title, 'Only In Y');
  const infoX = await questRegistryInfo('pack-x');
  assert.equal(infoX.count, 1);
  assert.equal(infoX.source, 'ftbq');
});
