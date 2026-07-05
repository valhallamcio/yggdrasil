import '../helpers/env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestMongo, type TestMongo } from '../helpers/mongo.ts';
import {
  setMetricsDbProvider,
  saveMetrics,
  downsampleHour,
  hourStart,
  latestStored,
  rawHistory,
  hourlyHistory,
} from '../../src/plugins/biforesting-link/metrics-history.ts';
import type { LinkIdentity, LinkMetrics } from '../../src/plugins/biforesting-link/types.ts';

let mongo: TestMongo;

const DB = 'ygg_metrics_test';

function identity(instanceKey: string): LinkIdentity {
  return { linkServerId: instanceKey, tag: instanceKey, instanceKey, name: instanceKey, resolved: true } as LinkIdentity;
}

function sample(mspt: number, players: number, extra: Partial<LinkMetrics> = {}): LinkMetrics {
  return { mspt, tps: 20, players, levels: 1, loadedChunks: 100, heapUsed: 1000, heapMax: 4000, ...extra };
}

before(async () => {
  mongo = await startTestMongo();
  setMetricsDbProvider(() => mongo.client.db(DB));
});
after(async () => mongo.stop());

test('metrics-history: raw samples persist and latest/rawHistory read them back', async () => {
  await saveMetrics(identity('pack-m'), sample(10, 2, { v: 2, msptMax: 30 }));
  await saveMetrics(identity('pack-m'), sample(20, 4));

  const latest = await latestStored('pack-m');
  assert.equal(latest?.metrics.mspt, 20, 'newest sample wins');

  const points = await rawHistory('pack-m', 1);
  assert.equal(points.length, 2);
  assert.equal(points[0]?.metrics.mspt, 10, 'ascending by time');
  assert.equal(points[0]?.metrics.msptMax, 30, 'v2 extras persisted verbatim');
});

test('metrics-history: downsampleHour folds one hour per instance and is idempotent', async () => {
  const col = mongo.client.db(DB).collection('biforesting_metrics');
  const hour = hourStart(new Date(Date.now() - 3600_000));
  const inHour = (min: number) => new Date(hour.getTime() + min * 60_000);

  await col.insertMany([
    { instanceKey: 'pack-h', tag: 'pack-h', serverId: null, at: inHour(5), metrics: sample(10, 2, { msptMax: 40 }) },
    { instanceKey: 'pack-h', tag: 'pack-h', serverId: null, at: inHour(25), metrics: sample(30, 6) },
    // other instance in the same hour gets its own doc
    { instanceKey: 'pack-h2', tag: 'pack-h2', serverId: null, at: inHour(30), metrics: sample(5, 1) },
    // outside the hour — must not be folded
    { instanceKey: 'pack-h', tag: 'pack-h', serverId: null, at: new Date(hour.getTime() + 3700_000), metrics: sample(99, 9) },
  ]);

  const folded = await downsampleHour(hour);
  assert.equal(folded, 2, 'one doc per instance in that hour');

  const rows = await hourlyHistory('pack-h', 3);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.samples, 2);
  assert.equal(rows[0]?.msptAvg, 20, 'avg of 10 and 30');
  assert.equal(rows[0]?.msptMax, 40, 'max prefers explicit v2 msptMax');
  assert.equal(rows[0]?.playersMax, 6);

  // idempotent: re-running the same hour updates in place, no duplicates
  await downsampleHour(hour);
  assert.equal((await hourlyHistory('pack-h', 3)).length, 1);
});
