import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Writer } from '../src/plugins/biforesting-link/frame-codec.ts';
import { decodeMetrics } from '../src/plugins/biforesting-link/decoders.ts';

/** Metrics v2 wire: [varint 2][utf json] on the same channel; v1 binary stays accepted. */

test('metrics codec: v2 JSON payload decodes with compat fields + per-dim detail', () => {
  const json = JSON.stringify({
    msptAvg: 12.34,
    msptMax: 48.1,
    tps: 19.98,
    players: 7,
    heapUsed: 1234567,
    heapMax: 8888888,
    perDim: [
      {
        dim: 'minecraft:overworld',
        tickMsAvg: 8.2,
        tickMsMax: 30.1,
        entities: [{ type: 'minecraft:zombie', n: 42 }],
        totalEntities: 210,
        loadedChunks: 900,
      },
      {
        dim: 'minecraft:the_nether',
        tickMsAvg: 1.1,
        tickMsMax: 2.2,
        entities: [],
        totalEntities: 3,
        loadedChunks: 100,
      },
    ],
    censusAgeMs: 12000,
  });
  const payload = new Writer().varInt(2).utf(json).build();

  const m = decodeMetrics(payload);
  assert.equal(m.v, 2);
  assert.equal(m.mspt, 12.34, 'compat mspt = v2 msptAvg');
  assert.equal(m.msptMax, 48.1);
  assert.equal(m.tps, 19.98);
  assert.equal(m.players, 7);
  assert.equal(m.levels, 2, 'compat levels = perDim.length');
  assert.equal(m.loadedChunks, 1000, 'compat loadedChunks = sum of perDim');
  assert.equal(m.heapUsed, 1234567);
  assert.equal(m.perDim?.[0]?.dim, 'minecraft:overworld');
  assert.equal(m.perDim?.[0]?.entities[0]?.n, 42);
  assert.equal(m.censusAgeMs, 12000);
});

test('metrics codec: v1 binary payload still decodes (no v2 fields)', () => {
  const payload = new Writer()
    .varInt(1)
    .float(25.5)
    .float(19.5)
    .varInt(4)
    .varInt(3)
    .varInt(777)
    .long(111n)
    .long(222n)
    .build();

  const m = decodeMetrics(payload);
  assert.equal(Math.round(m.mspt * 10) / 10, 25.5);
  assert.equal(m.players, 4);
  assert.equal(m.levels, 3);
  assert.equal(m.loadedChunks, 777);
  assert.equal(m.heapUsed, 111);
  assert.equal(m.v, undefined, 'v1 has no v2 extras');
  assert.equal(m.perDim, undefined);
});
