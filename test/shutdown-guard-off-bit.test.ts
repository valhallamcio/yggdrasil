import './helpers/env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeRegAck } from '../src/plugins/biforesting-link/decoders.ts';
import { Reader } from '../src/plugins/biforesting-link/frame-codec.ts';
import { policyPutBodySchema } from '../src/domains/biforesting/biforesting.schema.ts';
import { FEATURE_BITS, featureNamesForMask, maskForFeatures } from '../src/plugins/biforesting-link/policy-store.ts';

/**
 * The live off switch of the bifrost-lib shutdown guard (`PlayProtocol.CAP_SHUTDOWN_GUARD_OFF`).
 * The guard is on by default. Before this name existed, a policy PUT with it was dropped without an
 * error, so the switch did nothing.
 */

const OFF = 0x800000;

test('shutdown_guard_off is bit 0x800000, as in the mod', () => {
  assert.equal(FEATURE_BITS['shutdown_guard_off'], OFF);
  assert.equal(FEATURE_BITS['shutdown_guard'], 0x100000, 'the old marker bit stays');
});

test('every feature name has its own bit', () => {
  const bits = Object.values(FEATURE_BITS);
  for (const bit of bits) assert.equal(bit & (bit - 1), 0, `0x${bit.toString(16)} is one bit`);
  assert.equal(new Set(bits).size, bits.length);
});

test('a policy PUT by name keeps the other features and adds the off bit', () => {
  const body = { features: ['play_transport', 'ops', 'shutdown_guard_off'] };
  assert.ok(policyPutBodySchema.safeParse(body).success);
  const mask = maskForFeatures(body.features);
  assert.equal(mask, 0x10 | 0x400 | OFF);
  assert.deepEqual(featureNamesForMask(mask), ['play_transport', 'ops', 'shutdown_guard_off']);
});

test('the name matches without regard to case', () => {
  assert.equal(maskForFeatures(['SHUTDOWN_GUARD_OFF']), OFF);
});

test('reg_ack carries the off bit as a varint the mod reads back', () => {
  const buf = encodeRegAck({
    accepted: true,
    canonicalServerId: 'ptero-abc123',
    friendlyName: 'Arcadia',
    enabledFeatures: 0x410 | OFF,
    metricsHz: 0,
    questHz: 0,
    chunkHz: 0,
    serverTimeMillis: 1_700_000_000_000,
    negotiatedVersion: 2,
  });
  const r = new Reader(buf);
  assert.equal(r.varInt(), 2);
  assert.equal(r.byte(), 1);
  assert.equal(r.utf(), 'ptero-abc123');
  assert.equal(r.utf(), 'Arcadia');
  assert.equal(r.varInt(), 0x410 | OFF);
});
