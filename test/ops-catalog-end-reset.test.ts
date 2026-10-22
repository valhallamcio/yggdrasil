import './helpers/env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { catalogEntry } from '../src/domains/biforesting/ops-catalog.ts';
import { opCreateBodySchema } from '../src/domains/biforesting/biforesting.schema.ts';

/** end_reset_plan: the End reset dry run that Valhalla-Updater's end_reset job sends. */

test('end_reset_plan: known, server-global, safe, gated by the ops bit only', () => {
  const entry = catalogEntry('end_reset_plan');
  assert.ok(entry);
  assert.equal(entry.serverGlobal, true);
  assert.equal(entry.risk, 'safe');
  assert.equal(entry.requiresFeature, undefined);
  assert.equal(entry.internal, undefined, 'the generic ops route must accept it');
  assert.equal(entry.requiresConfirm, undefined);
  assert.equal(entry.requiresDryRunConfirm, undefined);
});

test('end_reset_plan: empty params only', () => {
  const p = catalogEntry('end_reset_plan')!.params;
  assert.equal(p.safeParse({}).success, true);
  assert.equal(p.safeParse({ resetId: 'x' }).success, false);
});

test('end_reset_plan: the body the updater sends passes the op create schema', () => {
  const body = { type: 'end_reset_plan', params: {}, expiresInMs: 300_000, execTimeoutMs: 600_000 };
  assert.equal(opCreateBodySchema.safeParse(body).success, true);
  assert.equal(opCreateBodySchema.safeParse({ ...body, execTimeoutMs: 600_001 }).success, false);
});
