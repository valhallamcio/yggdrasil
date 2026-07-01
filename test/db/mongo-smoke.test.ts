import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestMongo } from '../helpers/mongo.ts';

test('db harness: in-memory mongo insert/read/index round-trip', async () => {
  const mongo = await startTestMongo();
  try {
    const col = mongo.client.db('ygg_test').collection<{ _id: string; state: string }>('smoke');
    await col.createIndex({ state: 1 });
    await col.insertOne({ _id: 'op_smoke_1', state: 'pending' });
    const doc = await col.findOne({ _id: 'op_smoke_1' });
    assert.equal(doc?.state, 'pending');
    const byState = await col.find({ state: 'pending' }).toArray();
    assert.equal(byState.length, 1);
  } finally {
    await mongo.stop();
  }
});
