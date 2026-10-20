import '../helpers/env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestMongo, type TestMongo } from '../helpers/mongo.ts';
import {
  getPolicy,
  inheritedKey,
  resolvePolicy,
  setPolicy,
  setPolicyDbProvider,
  maskForFeatures,
  ZERO_POLICY,
} from '../../src/plugins/biforesting-link/policy-store.ts';

let mongo: TestMongo;

before(async () => {
  mongo = await startTestMongo();
  setPolicyDbProvider(() => mongo.client.db('ygg_policy_test'));
});
after(async () => mongo.stop());

test('policy-store: unknown instanceKey yields the ZERO policy (default-off)', async () => {
  const policy = await getPolicy('never-seen');
  assert.deepEqual(policy, ZERO_POLICY);
  assert.equal(policy.enabledFeatures, 0);
});

test('policy-store: setPolicy upserts and getPolicy returns the stored grant', async () => {
  const mask = maskForFeatures(['play_transport', 'ops']);
  assert.equal(mask, 0x410);
  const doc = await setPolicy('packx', { enabledFeatures: mask, metricsHz: 1 }, 'tester');
  assert.equal(doc.enabledFeatures, 0x410);
  assert.equal(doc.updatedBy, 'tester');

  const read = await getPolicy('packx');
  assert.equal(read.enabledFeatures, 0x410);
  assert.equal(read.metricsHz, 1);
  assert.equal(read.questHz, 0, 'untouched cadence stays at the zero default');
});

test('policy-store: partial update preserves other fields', async () => {
  await setPolicy('packy', { enabledFeatures: 0x10 }, 'a');
  await setPolicy('packy', { metricsHz: 5 }, 'b');
  const read = await getPolicy('packy');
  assert.equal(read.enabledFeatures, 0x10, 'features survive a cadence-only update');
  assert.equal(read.metricsHz, 5);
});

test('policy-store: db failure fails CLOSED to the ZERO policy', async () => {
  setPolicyDbProvider(() => {
    throw new Error('db down');
  });
  try {
    const policy = await getPolicy('packx');
    assert.deepEqual(policy, ZERO_POLICY, 'features never fail open');
  } finally {
    setPolicyDbProvider(() => mongo.client.db('ygg_policy_test'));
  }
});

test('policy-store: enabledFixes defaults to [] and round-trips', async () => {
  assert.deepEqual((await getPolicy('never-seen-fixes')).enabledFixes, []);

  await setPolicy('packf', { enabledFeatures: 0x410 }, 'a');
  assert.deepEqual((await getPolicy('packf')).enabledFixes, [], 'insert seeds the empty list');

  await setPolicy('packf', { enabledFixes: ['biforesting-canary', 'gregtech-recipe-cache'] }, 'b');
  const read = await getPolicy('packf');
  assert.deepEqual(read.enabledFixes, ['biforesting-canary', 'gregtech-recipe-cache']);
  assert.equal(read.enabledFeatures, 0x410, 'a fixes-only update keeps the feature bits');

  await setPolicy('packf', { metricsHz: 2 }, 'c');
  assert.deepEqual((await getPolicy('packf')).enabledFixes, ['biforesting-canary', 'gregtech-recipe-cache'],
    'a cadence-only update keeps the fixes');

  await setPolicy('packf', { enabledFixes: [] }, 'd');
  assert.deepEqual((await getPolicy('packf')).enabledFixes, [], 'an empty list turns every fix off');
});

test('policy-store: a doc stored before enabledFixes existed reads as no fixes', async () => {
  await mongo.client.db('ygg_policy_test').collection('biforesting_policies').insertOne({
    instanceKey: 'pre-fixes',
    enabledFeatures: 0x10,
    metricsHz: 0,
    questHz: 0,
    chunkHz: 0,
  });
  const read = await getPolicy('pre-fixes');
  assert.deepEqual(read.enabledFixes, []);
  assert.equal(read.enabledFeatures, 0x10);
});

// The resolver keys a server by `tag` while one doc has the tag and by `tag:serverId` once a
// second doc shares it. A grouped key with no doc of its own reads the tag doc.

test('policy-store: inheritedKey splits a grouped key and leaves a plain tag alone', () => {
  assert.equal(inheritedKey('onyx:1a2b3c4d'), 'onyx');
  assert.equal(inheritedKey('onyx'), null);
  assert.equal(inheritedKey(':1a2b3c4d'), null);
  assert.equal(inheritedKey('onyx:'), null);
});

test('policy-store: a single instance reads its own tag doc', async () => {
  await setPolicy('solo', { enabledFeatures: 0x30, metricsHz: 1 }, 'a');
  const { policy, sourceKey } = await resolvePolicy('solo');
  assert.equal(sourceKey, 'solo');
  assert.equal(policy.enabledFeatures, 0x30);
  assert.equal(policy.metricsHz, 1);
});

test('policy-store: both keys of a new sibling pair read the tag doc', async () => {
  await setPolicy('onyx', { enabledFeatures: 0x40bc60, metricsHz: 1, enabledFixes: ['biforesting-canary'] }, 'a');
  const tag = await getPolicy('onyx');
  for (const key of ['onyx:sid00001', 'onyx:sid00002']) {
    const { policy, sourceKey } = await resolvePolicy(key);
    assert.equal(sourceKey, 'onyx', key);
    assert.deepEqual(policy, tag, `${key} keeps the tag grant`);
  }
});

test('policy-store: a grouped key with no doc and no tag doc reads ZERO', async () => {
  const { policy, sourceKey } = await resolvePolicy('nodoc:sid00001');
  assert.equal(sourceKey, null);
  assert.deepEqual(policy, ZERO_POLICY);
});

test('policy-store: an own per-instance doc wins over the tag doc', async () => {
  await setPolicy('evol', { enabledFeatures: 0x30 }, 'a');
  await mongo.client.db('ygg_policy_test').collection('biforesting_policies').insertOne({
    instanceKey: 'evol:sid00001',
    enabledFeatures: 0x10,
    metricsHz: 0,
    questHz: 0,
    chunkHz: 0,
    enabledFixes: [],
  });
  const own = await resolvePolicy('evol:sid00001');
  assert.equal(own.sourceKey, 'evol:sid00001');
  assert.equal(own.policy.enabledFeatures, 0x10);
  assert.equal((await getPolicy('evol:sid00002')).enabledFeatures, 0x30, 'the sibling still inherits');
});

test('policy-store: a write to an inheriting key starts from the tag doc', async () => {
  await setPolicy('gto', { enabledFeatures: 0xbc60, metricsHz: 1, questHz: 2, enabledFixes: ['gregtech-recipe-cache'] }, 'a');
  const doc = await setPolicy('gto:sid00001', { metricsHz: 5 }, 'b');
  assert.equal(doc.instanceKey, 'gto:sid00001');
  assert.equal(doc.enabledFeatures, 0xbc60, 'the inherited bits survive a cadence-only write');
  assert.equal(doc.metricsHz, 5);
  assert.equal(doc.questHz, 2);
  assert.deepEqual(doc.enabledFixes, ['gregtech-recipe-cache']);

  await setPolicy('gto', { enabledFeatures: 0x10 }, 'c');
  assert.equal((await getPolicy('gto:sid00001')).enabledFeatures, 0xbc60, 'the own doc no longer follows the tag');
  assert.equal((await getPolicy('gto:sid00002')).enabledFeatures, 0x10, 'an inheriting sibling follows the tag');
});

test('policy-store: a write to a new grouped key with no tag doc starts from ZERO', async () => {
  const doc = await setPolicy('fresh:sid00001', { metricsHz: 1 }, 'a');
  assert.equal(doc.enabledFeatures, 0);
  assert.deepEqual(doc.enabledFixes, []);
});
