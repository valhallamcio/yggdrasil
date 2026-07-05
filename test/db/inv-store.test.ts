import '../helpers/env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestMongo, type TestMongo } from '../helpers/mongo.ts';
import {
  setInvDbProvider,
  saveInvSnapshot,
  listSnapshots,
  latestSnapshot,
  getSnapshot,
  RING_KEEP,
} from '../../src/plugins/biforesting-link/inv-store.ts';
import type { InvSnapHeader, LinkIdentity } from '../../src/plugins/biforesting-link/types.ts';

let mongo: TestMongo;
const DB = 'ygg_inv_test';

function identity(instanceKey: string): LinkIdentity {
  return { linkServerId: instanceKey, tag: instanceKey, instanceKey, name: instanceKey, resolved: true } as LinkIdentity;
}

function header(uuid: string, name: string, reason: string): InvSnapHeader {
  return {
    uuid,
    name,
    reason,
    dim: 'minecraft:overworld',
    pos: [1, 64, -3],
    dataVersion: 3955,
    items: [{ slot: 0, id: 'minecraft:diamond', count: 12 }],
  };
}

before(async () => {
  mongo = await startTestMongo();
  setInvDbProvider(() => mongo.client.db(DB));
});
after(async () => mongo.stop());

test('inv-store: snapshot persists with header fields + opaque gz; detail returns the blob', async () => {
  await saveInvSnapshot(identity('pack-i'), header('u-1', 'Steve', 'death'), Buffer.from([1, 2, 3]));

  const list = await listSnapshots('pack-i', 'u-1');
  assert.equal(list.length, 1);
  assert.equal(list[0]?.reason, 'death');
  assert.equal(list[0]?.items[0]?.id, 'minecraft:diamond');
  assert.equal(list[0]?.sizeBytes, 3);
  assert.equal((list[0] as unknown as Record<string, unknown>)['gz'], undefined, 'list never ships blobs');

  const detail = await getSnapshot(String(list[0]?._id));
  assert.ok(detail?.gz, 'detail carries the gz blob');
});

test('inv-store: ring keeps only the newest 25 per (instanceKey, uuid)', async () => {
  for (let i = 0; i < RING_KEEP + 3; i++) {
    await saveInvSnapshot(identity('pack-r'), header('u-r', 'Ring', `periodic-${i}`), Buffer.from([i]));
  }
  const list = await listSnapshots('pack-r', 'u-r', 100);
  assert.equal(list.length, RING_KEEP, 'trimmed to the ring size');
  assert.equal(list[0]?.reason, `periodic-${RING_KEEP + 2}`, 'newest kept');
  // other players' rings are untouched
  await saveInvSnapshot(identity('pack-r'), header('u-other', 'Other', 'join'), Buffer.from([9]));
  assert.equal((await listSnapshots('pack-r', 'u-other')).length, 1);
});

test('inv-store: latestSnapshot resolves by uuid or case-insensitive name', async () => {
  await saveInvSnapshot(identity('pack-n'), header('u-n', 'CamelCase', 'join'), Buffer.from([1]));
  assert.equal((await latestSnapshot('pack-n', 'u-n'))?.name, 'CamelCase');
  assert.equal((await latestSnapshot('pack-n', 'camelcase'))?.uuid, 'u-n');
  assert.equal(await latestSnapshot('pack-n', 'nobody'), null);
});
