import './helpers/env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeRegAck } from '../src/plugins/biforesting-link/decoders.ts';
import { Reader } from '../src/plugins/biforesting-link/frame-codec.ts';
import { policyPutBodySchema } from '../src/domains/biforesting/biforesting.schema.ts';
import { MAX_ENABLED_FIXES, normalizeFixIds } from '../src/plugins/biforesting-link/policy-store.ts';
import type { RegAck } from '../src/plugins/biforesting-link/types.ts';

const base: RegAck = {
  accepted: true,
  canonicalServerId: 'ptero-abc123',
  friendlyName: 'Arcadia',
  enabledFeatures: 0x410,
  metricsHz: 1,
  questHz: 0,
  chunkHz: 0,
  serverTimeMillis: 1_700_000_000_000,
  negotiatedVersion: 2,
};

function readHead(r: Reader): void {
  assert.equal(r.varInt(), 2);
  assert.equal(r.byte(), 1);
  assert.equal(r.utf(), 'ptero-abc123');
  assert.equal(r.utf(), 'Arcadia');
  assert.equal(r.varInt(), 0x410);
  assert.equal(r.varInt(), 1);
  assert.equal(r.varInt(), 0);
  assert.equal(r.varInt(), 0);
  assert.equal(r.long(), 1_700_000_000_000n);
  assert.equal(r.varInt(), 2);
}

test('encodeRegAck appends the enabledFixes tail after negotiatedVersion', () => {
  const buf = encodeRegAck({ ...base, enabledFixes: ['biforesting-canary', 'gregtech-recipe-cache'] });
  const r = new Reader(buf);
  readHead(r);
  assert.equal(r.varInt(), 2, 'fix count');
  assert.equal(r.utf(), 'biforesting-canary');
  assert.equal(r.utf(), 'gregtech-recipe-cache');
  assert.equal(r.remaining(), 0);
});

test('encodeRegAck writes no tail for an empty or missing list (old byte layout)', () => {
  const plain = encodeRegAck(base);
  assert.deepEqual(encodeRegAck({ ...base, enabledFixes: [] }), plain);
  const r = new Reader(plain);
  readHead(r);
  assert.equal(r.remaining(), 0, 'nothing after negotiatedVersion');
});

test('policy PUT schema: enabledFixes accepts valid ids, alone or with features', () => {
  assert.ok(policyPutBodySchema.safeParse({ enabledFixes: ['biforesting-canary'] }).success);
  assert.ok(policyPutBodySchema.safeParse({ enabledFixes: [] }).success, '[] turns every fix off');
  assert.ok(policyPutBodySchema.safeParse({ features: ['ops'], enabledFixes: ['gregtech-recipe-cache'] }).success);
});

test('policy PUT schema: enabledFixes rejects bad ids and oversized lists', () => {
  for (const bad of ['canary', 'GregTech-cache', 'gregtech-', 'a b-c', 'x-' + 'y'.repeat(70)]) {
    assert.equal(policyPutBodySchema.safeParse({ enabledFixes: [bad] }).success, false, bad);
  }
  const tooMany = Array.from({ length: MAX_ENABLED_FIXES + 1 }, (_, i) => `mod-fix${i}`);
  assert.equal(policyPutBodySchema.safeParse({ enabledFixes: tooMany }).success, false);
  const max = Array.from({ length: MAX_ENABLED_FIXES }, (_, i) => `mod-fix${i}`);
  assert.ok(policyPutBodySchema.safeParse({ enabledFixes: max }).success);
});

test('normalizeFixIds dedupes in first-seen order', () => {
  assert.deepEqual(normalizeFixIds(['b-x', 'a-y', 'b-x']), ['b-x', 'a-y']);
});
