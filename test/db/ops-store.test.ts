import '../helpers/env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestMongo, type TestMongo } from '../helpers/mongo.ts';
import { OpsStore, OP_DEFAULTS } from '../../src/plugins/biforesting-link/ops-store.ts';
import type { OpDoc } from '../../src/plugins/biforesting-link/types.ts';

let mongo: TestMongo;
let store: OpsStore;
let seq = 0;

before(async () => {
  mongo = await startTestMongo();
  store = new OpsStore(() => mongo.client.db('ygg_ops_test'));
});
after(async () => mongo.stop());

function mkInput(overrides: Record<string, unknown> = {}) {
  return {
    instanceKey: 'testpack',
    serverTag: 'testpack',
    type: 'echo',
    params: { message: `hi ${++seq}` },
    createdBy: 'test',
    ...overrides,
  };
}

test('ops-store: create yields pending with defaults + audit trail', async () => {
  const { op, replayed } = await store.create(mkInput());
  assert.equal(replayed, false);
  assert.equal(op.state, 'pending');
  assert.equal(op.attempts, 0);
  assert.equal(op.maxAttempts, OP_DEFAULTS.maxAttempts);
  assert.match(op._id, /^[0-9A-HJKMNP-TV-Z]{26}$/, 'opId is a ULID');
  assert.equal(op.audit.length, 1);
  assert.equal(op.audit[0]!.to, 'pending');
  assert.ok(op.expiresAt.getTime() > Date.now() + 6 * 24 * 3600_000, 'default expiry ≈ +7d');
});

test('ops-store: idempotencyKey replay returns the EXISTING op, no duplicate', async () => {
  const key = 'replay-key-12345';
  const first = await store.create(mkInput({ idempotencyKey: key }));
  const second = await store.create(mkInput({ idempotencyKey: key, params: { message: 'different' } }));
  assert.equal(second.replayed, true);
  assert.equal(second.op._id, first.op._id);
  assert.deepEqual(second.op.params, first.op.params, 'replay returns the original params');
});

test('ops-store: happy path pending → dispatched → acked → completed, audit appended', async () => {
  const { op } = await store.create(mkInput());
  const d = await store.markDispatched(op._id);
  assert.equal(d?.state, 'dispatched');
  assert.equal(d?.attempts, 1);
  const a = await store.markAcked(op._id);
  assert.equal(a?.state, 'acked');
  const c = await store.markCompleted(op._id, { ok: true, data: { out: 'x' }, durationMs: 3 });
  assert.equal(c?.state, 'completed');
  assert.deepEqual(c?.result, { ok: true, data: { out: 'x' }, durationMs: 3 });
  assert.deepEqual(
    c?.audit.map((e) => e.to),
    ['pending', 'dispatched', 'acked', 'completed'],
  );
});

test('ops-store: illegal transitions are refused (CAS guard)', async () => {
  const { op } = await store.create(mkInput());
  assert.equal(await store.markAcked(op._id), null, 'pending cannot ack');
  assert.equal(await store.markCompleted(op._id, { ok: true }), null, 'pending cannot complete');
  await store.markDispatched(op._id);
  await store.markAcked(op._id);
  assert.equal(await store.markDispatched(op._id), null, 'acked cannot re-dispatch');
  await store.markCompleted(op._id, { ok: true });
  assert.equal(await store.markCompleted(op._id, { ok: true }), null, 'completed is terminal (dup result no-op)');
  assert.equal(await store.cancel(op._id, 'test'), null, 'completed cannot be cancelled');
  const final = await store.get(op._id);
  assert.equal(final?.state, 'completed');
});

test('ops-store: result landing while still dispatched (lost ack) completes', async () => {
  const { op } = await store.create(mkInput());
  await store.markDispatched(op._id);
  const c = await store.markCompleted(op._id, { ok: true });
  assert.equal(c?.state, 'completed');
});

test('ops-store: cancel allowed pre-ack only', async () => {
  const { op: p } = await store.create(mkInput());
  assert.equal((await store.cancel(p._id, 'alice'))?.state, 'cancelled');

  const { op: d } = await store.create(mkInput());
  await store.markDispatched(d._id);
  assert.equal((await store.cancel(d._id, 'alice'))?.state, 'cancelled');

  const { op: a } = await store.create(mkInput());
  await store.markDispatched(a._id);
  await store.markAcked(a._id);
  assert.equal(await store.cancel(a._id, 'alice'), null, 'acked (executing) cannot be cancelled');
});

test('ops-store: bootReset requeues every dispatched op', async () => {
  const { op: d1 } = await store.create(mkInput());
  const { op: d2 } = await store.create(mkInput());
  await store.markDispatched(d1._id);
  await store.markDispatched(d2._id);
  const n = await store.bootReset();
  assert.ok(n >= 2);
  assert.equal((await store.get(d1._id))?.state, 'pending');
  assert.equal((await store.get(d2._id))?.state, 'pending');
  assert.ok((await store.get(d1._id))?.audit.some((e) => e.note?.includes('boot-reset')));
});

test('ops-store: dispatch timeout requeues, then fails at maxAttempts', async () => {
  const { op } = await store.create(mkInput({ maxAttempts: 2, dispatchTimeoutMs: 1_000 }));
  const later = new Date(Date.now() + 5_000);

  await store.markDispatched(op._id);
  let stale = await store.findStaleDispatched(later);
  assert.ok(stale.some((o) => o._id === op._id));
  const r1 = await store.requeueOrFail(stale.find((o) => o._id === op._id)!);
  assert.equal(r1?.state, 'pending', 'attempt 1 < max: requeued');

  await store.markDispatched(op._id);
  stale = await store.findStaleDispatched(later);
  const r2 = await store.requeueOrFail(stale.find((o) => o._id === op._id)!);
  assert.equal(r2?.state, 'failed', 'attempts exhausted: failed');
  assert.match(r2?.result?.error ?? '', /no ack after 2/);
});

test('ops-store: exec timeout (acked, no result) is detectable', async () => {
  const { op } = await store.create(mkInput({ execTimeoutMs: 1_000 }));
  await store.markDispatched(op._id);
  await store.markAcked(op._id);
  const stale = await store.findStaleAcked(new Date(Date.now() + 5_000));
  assert.ok(stale.some((o) => o._id === op._id));
});

test('ops-store: expiry covers pending, dispatched and waiting_player', async () => {
  const { op } = await store.create(mkInput({ expiresInMs: 60_000 }));
  const afterExpiry = new Date(Date.now() + 120_000);
  const expired = await store.findExpired(afterExpiry);
  assert.ok(expired.some((o) => o._id === op._id));
  assert.equal((await store.markExpired(op._id))?.state, 'expired');
});

test('ops-store: findDispatchable respects notBefore and expiry', async () => {
  const { op: ready } = await store.create(mkInput({ instanceKey: 'dispatchable-test' }));
  const { op: later } = await store.create(
    mkInput({ instanceKey: 'dispatchable-test', notBefore: new Date(Date.now() + 3600_000) }),
  );
  const ids = (await store.findDispatchable('dispatchable-test')).map((o: OpDoc) => o._id);
  assert.ok(ids.includes(ready._id));
  assert.ok(!ids.includes(later._id), 'notBefore in the future is held back');
});

test('ops-store: waiting_player parks and requeues by uuid or name (case-insensitive)', async () => {
  const target = { uuid: '11111111-2222-3333-4444-555555555555', name: 'SomePlayer' };
  const { op } = await store.create(mkInput({ instanceKey: 'wp-test', target }));
  await store.markDispatched(op._id);
  assert.equal((await store.markWaitingPlayer(op._id))?.state, 'waiting_player');

  const byUuid = await store.findWaitingForPlayer('wp-test', target.uuid, 'unrelated');
  assert.ok(byUuid.some((o) => o._id === op._id));
  const byName = await store.findWaitingForPlayer('wp-test', 'other-uuid', 'sOmEpLaYeR');
  assert.ok(byName.some((o) => o._id === op._id));
  const miss = await store.findWaitingForPlayer('wp-test', 'other-uuid', 'NotHim');
  assert.ok(!miss.some((o) => o._id === op._id));

  assert.equal((await store.requeueWaiting(op._id, 'player joined'))?.state, 'pending');
});
