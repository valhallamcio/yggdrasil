import '../helpers/env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestMongo, type TestMongo } from '../helpers/mongo.ts';
import { setIconDbProvider, saveIcons, getIcon, iconInfo } from '../../src/plugins/biforesting-link/icon-store.ts';

let mongo: TestMongo;
const DB = 'ygg_icon_test';

function png(byte: number): Buffer {
  // not a real PNG — the store treats bytes opaquely; content only matters for sha identity
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, byte, byte, byte, byte]);
}

before(async () => {
  mongo = await startTestMongo();
  setIconDbProvider(() => mongo.client.db(DB));
});
after(async () => mongo.stop());

test('icon-store: identical PNG bytes dedup to one GridFS blob', async () => {
  const shared = png(0x11);
  const res = await saveIcons('pack-a', [
    { id: 'minecraft:stone', png: shared },
    { id: 'minecraft:dirt', png: shared }, // same bytes → deduped
    { id: 'minecraft:diamond', png: png(0x22) },
  ]);
  assert.equal(res.mapped, 3, 'all three ids mapped');
  assert.equal(res.stored, 2, 'two distinct blobs stored');
  assert.equal(res.deduped, 1, 'the repeated blob deduped');

  const info = await iconInfo('pack-a');
  assert.equal(info.mapped, 3);
  assert.equal(info.blobs, 2, 'two distinct shas back three ids');
});

test('icon-store: getIcon round-trips the exact bytes; re-upload replaces the mapping', async () => {
  const original = png(0x33);
  await saveIcons('pack-b', [{ id: 'create:cogwheel', png: original }]);
  const got = await getIcon('pack-b', 'create:cogwheel');
  assert.ok(got);
  assert.deepEqual([...got!], [...original]);

  // re-upload the same id with new bytes → mapping now points at the new blob
  const updated = png(0x44);
  const res = await saveIcons('pack-b', [{ id: 'create:cogwheel', png: updated }]);
  assert.equal(res.mapped, 1);
  const got2 = await getIcon('pack-b', 'create:cogwheel');
  assert.deepEqual([...got2!], [...updated]);

  // mapping count didn't grow (upsert on pack+id)
  assert.equal((await iconInfo('pack-b')).mapped, 1);
});

test('icon-store: unmapped id returns null; packs are isolated', async () => {
  await saveIcons('pack-c', [{ id: 'minecraft:stone', png: png(0x55) }]);
  assert.equal(await getIcon('pack-c', 'minecraft:unknown'), null);
  assert.equal(await getIcon('other-pack', 'minecraft:stone'), null, 'pack-scoped');
});

test('icon-store: re-mapping an id reaps the orphaned blob once unreferenced', async () => {
  const db = mongo.client.db(DB);
  const first = png(0x66);
  await saveIcons('pack-orphan', [{ id: 'mod:widget', png: first }]);
  const blobsBefore = await db.collection('biforesting_icons.files').countDocuments({});

  // replace the icon's pixels — the old blob has no other referent and must be reaped
  await saveIcons('pack-orphan', [{ id: 'mod:widget', png: png(0x77) }]);
  const blobsAfter = await db.collection('biforesting_icons.files').countDocuments({});
  assert.equal(blobsAfter, blobsBefore, 'orphaned blob deleted, replacement stored');

  // but a blob still referenced by ANOTHER mapping survives a re-map
  const shared = png(0x88);
  await saveIcons('pack-orphan', [{ id: 'mod:a', png: shared }, { id: 'mod:b', png: shared }]);
  await saveIcons('pack-orphan', [{ id: 'mod:a', png: png(0x99) }]);
  const got = await getIcon('pack-orphan', 'mod:b');
  assert.deepEqual([...got!], [...shared], 'shared blob survives one referent re-mapping');
});
