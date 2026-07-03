import '../helpers/env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestMongo, type TestMongo } from '../helpers/mongo.ts';
import {
  getPolicy,
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
