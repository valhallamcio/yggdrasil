import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Writer } from '../src/plugins/biforesting-link/frame-codec.ts';
import { decodeLedger, decodeMetrics } from '../src/plugins/biforesting-link/decoders.ts';

/** Metrics v2 wire: [varint 2][utf json] on the same channel; v1 binary stays accepted. */

const BASE = { msptAvg: 45.2, msptMax: 80, tps: 19.5, players: 6, heapUsed: 1, heapMax: 2, perDim: [], censusAgeMs: 0 };

function v2(json: string) {
  return decodeMetrics(new Writer().varInt(2).utf(json).build());
}

/** The spec example of the ledger block (cost-ledger.md, v1). */
const LEDGER = {
  v: 1,
  windowTicks: 100,
  tickMs: 45.2,
  coverage: 0.83,
  sources: { be_chunk: 14.9, ae2_service: 3.1, ae2_tickable: 0.7, conduit: 2.6, other: 1.2 },
  enclosing: [{ name: 'ae2:TickHandler.onServerTick', ms: 3.7, coverage: 0.97 }],
  owners: [
    { name: "quanglocle's Party", ms: 6.1, maxDivisor: 4 },
    { name: '(other)', ms: 9.3, maxDivisor: 1 },
  ],
  budget: {
    mode: 'team', msptEma: 47.1, machineMs: 30.2, budgetMs: 30.0, capMs: 4.2,
    throttledUnits: 12, throttledOwners: 3, savingMs: 5.5,
  },
};

test('metrics codec: the ledger block passes through as sent', () => {
  const m = v2(JSON.stringify({ ...BASE, ledger: LEDGER }));
  assert.deepEqual(m.ledger, LEDGER);
  assert.equal(m.mspt, 45.2, 'base fields stay');
});

test('metrics codec: a payload without a ledger block has no ledger key', () => {
  const m = v2(JSON.stringify(BASE));
  assert.ok(!('ledger' in m));
  for (const bad of [null, 'x', 7, [LEDGER]]) {
    assert.ok(!('ledger' in v2(JSON.stringify({ ...BASE, ledger: bad }))), `ledger ${JSON.stringify(bad)} is dropped`);
  }
});

test('metrics codec: bad ledger fields and rows are dropped, never thrown', () => {
  const ledger = {
    v: 1,
    windowTicks: '100',
    tickMs: null,
    coverage: 0.5,
    sources: { be_chunk: 2, conduit: 'x', $set: 1, 'a.b': 1, '': 1, ['__proto__']: 3 },
    enclosing: [{ name: 7, ms: 1 }, { name: 'e', ms: 1.5, coverage: 'x' }, 'row'],
    owners: [null, { name: 't', ms: '1' }, { name: 'u', ms: 1, maxDivisor: '2' }, { name: 'w', ms: 2, maxDivisor: 8 }],
    budget: { mode: 5, msptEma: 47, capMs: 'x', throttledUnits: 3 },
  };
  // 1e999 parses to Infinity, which JSON.stringify cannot write
  const json = JSON.stringify({ ...BASE, ledger }).replace('"coverage":0.5', '"coverage":1e999');
  const m = v2(json);
  assert.deepEqual(m.ledger, {
    v: 1,
    sources: { be_chunk: 2 },
    enclosing: [{ name: 'e', ms: 1.5 }],
    owners: [{ name: 'u', ms: 1 }, { name: 'w', ms: 2, maxDivisor: 8 }],
    budget: { msptEma: 47, throttledUnits: 3 },
  });
  assert.equal(Object.getPrototypeOf(m.ledger?.sources), Object.prototype);
  assert.deepEqual(v2(JSON.stringify({ ...BASE, ledger: { budget: [], sources: [], owners: {} } })).ledger, {
    sources: {}, enclosing: [], owners: [],
  });
});

test('decodeLedger never throws on junk', () => {
  for (const junk of [undefined, null, 0, '', [], {}, { sources: null }, { owners: [[]] }, { enclosing: [{}] }, { budget: null }]) {
    assert.doesNotThrow(() => decodeLedger(junk));
  }
  assert.equal(decodeLedger(undefined), undefined);
  assert.deepEqual(decodeLedger({}), { sources: {}, enclosing: [], owners: [] });
});

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
