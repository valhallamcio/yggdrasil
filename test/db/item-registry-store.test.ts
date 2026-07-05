import '../helpers/env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestMongo, type TestMongo } from '../helpers/mongo.ts';
import {
  setItemRegDbProvider,
  saveItemRegistry,
  searchItems,
  itemRegistryInfo,
} from '../../src/plugins/biforesting-link/item-registry-store.ts';
import { setPackLangDbProvider, savePackLang } from '../../src/plugins/biforesting-link/pack-lang-store.ts';
import type { ItemRegPayload, ItemRegRow, LinkIdentity } from '../../src/plugins/biforesting-link/types.ts';

let mongo: TestMongo;
const DB = 'ygg_itemreg_test';

function identity(instanceKey: string): LinkIdentity {
  return { linkServerId: instanceKey, tag: instanceKey, instanceKey, name: instanceKey, resolved: true } as LinkIdentity;
}

function item(id: string, display: string, extra: Partial<ItemRegRow> = {}): ItemRegRow {
  const mod = id.includes(':') ? id.slice(0, id.indexOf(':')) : 'minecraft';
  return { id, num: 0, mod, display, maxStack: 64, variants: [], ...extra };
}

function payload(source: string, items: ItemRegRow[], complete = true): ItemRegPayload {
  return { version: 2, source, complete, count: items.length, items };
}

before(async () => {
  mongo = await startTestMongo();
  setItemRegDbProvider(() => mongo.client.db(DB));
  setPackLangDbProvider(() => mongo.client.db(DB));
});
after(async () => mongo.stop());

test('itemreg-store: dump persists rows and a re-dump replaces the whole instance registry', async () => {
  await saveItemRegistry(identity('pack-a'), payload('modern', [
    item('minecraft:stone', 'Stone'),
    item('minecraft:dirt', 'Dirt'),
    item('removed:later', 'Removed Later'),
  ]));
  let info = await itemRegistryInfo('pack-a');
  assert.equal(info.count, 3);
  assert.equal(info.source, 'modern');
  assert.ok(info.dumpedAt);

  // re-dump: 'removed:later' vanished from the pack, a new item appeared — dump is authoritative
  await saveItemRegistry(identity('pack-a'), payload('modern', [
    item('minecraft:stone', 'Stone'),
    item('brand:new', 'Brand New'),
  ]));
  info = await itemRegistryInfo('pack-a');
  assert.equal(info.count, 2, 'replaced, not appended');
  assert.equal((await searchItems('pack-a', 'Removed Later')).length, 0, 'deleted item is gone');
  assert.equal((await searchItems('pack-a', 'Brand New'))[0]?.id, 'brand:new');
});

test('itemreg-store: search resolves exact id, mod prefix, text words, and substrings', async () => {
  await saveItemRegistry(identity('pack-s'), payload('forge-1.12', [
    item('gregtech:gt.metaitem.01', 'Meta Item', {
      num: 4097,
      variants: [{ meta: 32001, display: 'Copper Dust' }, { meta: 32002, display: 'Tin Dust' }],
    }),
    item('minecraft:diamond_sword', 'Diamond Sword'),
    item('minecraft:diamond', 'Diamond'),
    item('create:cogwheel', 'Cogwheel'),
  ]));

  // exact id wins
  const byId = await searchItems('pack-s', 'minecraft:diamond');
  assert.equal(byId.length, 1);
  assert.equal(byId[0]?.display, 'Diamond');

  // `mod:` prefix lists a mod's items
  const byMod = await searchItems('pack-s', 'minecraft:');
  assert.equal(byMod.length, 2);
  assert.ok(byMod.every((d) => d.mod === 'minecraft'));

  // $text word search on display
  const diamond = await searchItems('pack-s', 'diamond');
  assert.equal(diamond.length, 2);

  // metaitem variant display is searchable
  const copper = await searchItems('pack-s', 'Copper Dust');
  assert.equal(copper[0]?.id, 'gregtech:gt.metaitem.01');

  // partial word → substring fallback ($text can't match 'cogw')
  const partial = await searchItems('pack-s', 'cogw');
  assert.equal(partial[0]?.id, 'create:cogwheel');

  // no search string lists the registry
  assert.equal((await searchItems('pack-s', undefined)).length, 4);
});

test('itemreg-store: instances are isolated', async () => {
  await saveItemRegistry(identity('pack-x'), payload('modern', [item('only:x', 'Only In X')]));
  await saveItemRegistry(identity('pack-y'), payload('modern', [item('only:y', 'Only In Y')]));
  assert.equal((await searchItems('pack-x', 'Only'))[0]?.id, 'only:x');
  assert.equal((await searchItems('pack-y', 'Only'))[0]?.id, 'only:y');
});

test('itemreg-store: uploaded pack lang resolves lang-key displays at ingest (R2)', async () => {
  // pack ships display strings that are actually lang KEYS (client-only lang, e.g. nomifactory BQ)
  await savePackLang('pack-lang', {
    'item.nomilabs.circuit.name': 'Advanced Circuit',
    'item.nomilabs.plate.name': 'Reinforced Plate',
  });
  await saveItemRegistry(identity('pack-lang'), payload('forge-1.12', [
    item('nomilabs:circuit', 'item.nomilabs.circuit.name'),
    item('nomilabs:plate', 'item.nomilabs.plate.name'),
    item('minecraft:stone', 'Stone'), // already English — left untouched
  ]));

  // the raw key was resolved to real text at ingest; searching the resolved words finds it
  assert.equal((await searchItems('pack-lang', 'Advanced Circuit'))[0]?.id, 'nomilabs:circuit');
  const circuit = await searchItems('pack-lang', 'nomilabs:circuit'); // exact id
  assert.equal(circuit[0]?.display, 'Advanced Circuit', 'lang key resolved, not stored raw');
  const stone = await searchItems('pack-lang', 'minecraft:stone');
  assert.equal(stone[0]?.display, 'Stone', 'non-key display untouched');
});

test('itemreg-store: 100k-row ingest + search stays fast', async () => {
  const N = 100_000;
  const items: ItemRegRow[] = new Array(N);
  for (let i = 0; i < N; i++) {
    items[i] = item(`bulkmod:item_${i}`, `Bulk Item ${i}`);
  }
  // a single searchable needle in the haystack
  items[54_321] = item('bulkmod:needle', 'Enriched Naquadah Ingot');

  const t0 = Date.now();
  await saveItemRegistry(identity('pack-big'), payload('modern', items));
  const ingestMs = Date.now() - t0;

  const info = await itemRegistryInfo('pack-big');
  assert.equal(info.count, N);

  const t1 = Date.now();
  const hit = await searchItems('pack-big', 'Naquadah');
  const searchMs = Date.now() - t1;
  assert.equal(hit[0]?.id, 'bulkmod:needle');

  // generous gates — indexed search must not scan; ingest is one bulk insert
  assert.ok(searchMs < 500, `text search took ${searchMs}ms (expected < 500)`);
  assert.ok(ingestMs < 60_000, `100k ingest took ${ingestMs}ms (expected < 60s)`);
});
