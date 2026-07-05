import '../helpers/env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestMongo, type TestMongo } from '../helpers/mongo.ts';
import { OpsStore } from '../../src/plugins/biforesting-link/ops-store.ts';
import { OpDispatcher, OP_CHANNEL } from '../../src/plugins/biforesting-link/op-dispatcher.ts';
import { decodeJsonPayload } from '../../src/plugins/biforesting-link/decoders.ts';
import { setPolicy, setPolicyDbProvider, maskForFeatures } from '../../src/plugins/biforesting-link/policy-store.ts';

let mongo: TestMongo;
let store: OpsStore;
let seq = 0;

/** Dispatch is policy-gated: grant the ops bit for an instance under test. */
async function grantOps(instanceKey: string): Promise<void> {
  await setPolicy(instanceKey, { enabledFeatures: maskForFeatures(['play_transport', 'ops']) }, 'test');
}

/** Capturing fake of the link manager: records DOWN sends, per-instance liveness switch. */
function mkPort() {
  const sent: Array<{ instanceKey: string; channel: string; body: Record<string, unknown> }> = [];
  const live = new Set<string>();
  return {
    sent,
    live,
    sendDown: (instanceKey: string, channel: string, payload: Buffer) => {
      if (!live.has(instanceKey)) return false;
      sent.push({ instanceKey, channel, body: decodeJsonPayload(payload) as Record<string, unknown> });
      return true;
    },
    liveInstanceKeys: () => [...live],
  };
}

before(async () => {
  mongo = await startTestMongo();
  store = new OpsStore(() => mongo.client.db('ygg_dispatch_test'));
  setPolicyDbProvider(() => mongo.client.db('ygg_dispatch_test'));
  for (const key of ['pack-a', 'pack-down', 'pack-b', 'pack-c', 'pack-evil', 'pack-f', 'pack-w', 'pack-s', 'pack-e', 'pack-t']) {
    await grantOps(key);
  }
});
after(async () => mongo.stop());

function mkInput(instanceKey: string, overrides: Record<string, unknown> = {}) {
  return {
    instanceKey,
    serverTag: instanceKey,
    type: 'echo',
    params: { message: `hi ${++seq}` },
    createdBy: 'test',
    ...overrides,
  };
}

test('dispatcher: pending op goes DOWN the live link as [varint][utf json] on biforesting:op', async () => {
  const port = mkPort();
  const d = new OpDispatcher(store, port);
  port.live.add('pack-a');

  const { op } = await store.create(mkInput('pack-a'));
  await d.onLinkUp('pack-a');

  assert.equal(port.sent.length, 1);
  const wire = port.sent[0]!;
  assert.equal(wire.channel, OP_CHANNEL);
  assert.equal(wire.instanceKey, 'pack-a');
  assert.equal(wire.body['opId'], op._id);
  assert.equal(wire.body['type'], 'echo');
  assert.deepEqual(wire.body['params'], op.params);
  assert.equal((await store.get(op._id))?.state, 'dispatched');
});

test('dispatcher: op for a dead link eagerly rolls back to pending; link-up redelivers', async () => {
  const port = mkPort();
  const d = new OpDispatcher(store, port);

  const { op } = await store.create(mkInput('pack-down'));
  await d.onOpCreated(op);
  // markDispatched won the CAS but the write failed — eager rollback, because link-up
  // redispatch only considers `pending` (a stranded `dispatched` would wait for the sweep).
  assert.equal((await store.get(op._id))?.state, 'pending', 'eagerly requeued');

  port.live.add('pack-down');
  await d.onLinkUp('pack-down');
  assert.equal((await store.get(op._id))?.state, 'dispatched');
  assert.equal(port.sent.length, 1);
});

test('dispatcher: op_res ack + completed drive the op to completed; dup result is a no-op', async () => {
  const port = mkPort();
  const d = new OpDispatcher(store, port);
  port.live.add('pack-b');

  const { op } = await store.create(mkInput('pack-b'));
  await d.onLinkUp('pack-b');

  await d.onOpRes('pack-b', { opId: op._id, phase: 'ack' });
  assert.equal((await store.get(op._id))?.state, 'acked');

  await d.onOpRes('pack-b', { opId: op._id, phase: 'result', status: 'completed', result: { echoed: 'x' }, durationMs: 4 });
  const done = await store.get(op._id);
  assert.equal(done?.state, 'completed');
  assert.deepEqual(done?.result, { ok: true, data: { echoed: 'x' }, durationMs: 4 });

  // duplicate result (fake-mod --op-mode dup): terminal state unchanged, no extra audit entries
  const auditLen = done!.audit.length;
  await d.onOpRes('pack-b', { opId: op._id, phase: 'result', status: 'completed', result: { echoed: 'x' } });
  const after2 = await store.get(op._id);
  assert.equal(after2?.state, 'completed');
  assert.equal(after2?.audit.length, auditLen);
});

test('dispatcher: op_res from the WRONG backend is ignored', async () => {
  const port = mkPort();
  const d = new OpDispatcher(store, port);
  port.live.add('pack-c');

  const { op } = await store.create(mkInput('pack-c'));
  await d.onLinkUp('pack-c');
  await d.onOpRes('pack-evil', { opId: op._id, phase: 'result', status: 'completed' });
  assert.equal((await store.get(op._id))?.state, 'dispatched', 'not completed by a foreign instance');
});

test('dispatcher: failed op_res records the error', async () => {
  const port = mkPort();
  const d = new OpDispatcher(store, port);
  port.live.add('pack-f');

  const { op } = await store.create(mkInput('pack-f'));
  await d.onLinkUp('pack-f');
  await d.onOpRes('pack-f', { opId: op._id, phase: 'result', status: 'failed', error: 'boom' });
  const failed = await store.get(op._id);
  assert.equal(failed?.state, 'failed');
  assert.equal(failed?.result?.error, 'boom');
});

test('dispatcher: waiting_player parks; presence join requeues + re-dispatches', async () => {
  const port = mkPort();
  const d = new OpDispatcher(store, port);
  port.live.add('pack-w');

  const target = { uuid: '99999999-8888-7777-6666-555555555555', name: 'Sleeper' };
  const { op } = await store.create(mkInput('pack-w', { target }));
  await d.onLinkUp('pack-w');
  await d.onOpRes('pack-w', { opId: op._id, phase: 'result', status: 'waiting_player' });
  assert.equal((await store.get(op._id))?.state, 'waiting_player');

  // unrelated player joining does nothing
  await d.onPresence('pack-w', { event: 'join', player: { uuid: 'other', name: 'Other' }, online: null });
  assert.equal((await store.get(op._id))?.state, 'waiting_player');

  // the target joining requeues + re-dispatches immediately
  const sentBefore = port.sent.length;
  await d.onPresence('pack-w', { event: 'join', player: target, online: null });
  assert.equal((await store.get(op._id))?.state, 'dispatched');
  assert.equal(port.sent.length, sentBefore + 1);
  assert.equal(port.sent.at(-1)!.body['opId'], op._id);
});

test('dispatcher: presence snapshot wakes waiting ops too (link-up after restart)', async () => {
  const port = mkPort();
  const d = new OpDispatcher(store, port);
  port.live.add('pack-s');

  const target = { uuid: '12121212-3434-5656-7878-909090909090', name: 'Snapshotted' };
  const { op } = await store.create(mkInput('pack-s', { target }));
  await d.onLinkUp('pack-s');
  await d.onOpRes('pack-s', { opId: op._id, phase: 'result', status: 'waiting_player' });

  await d.onPresence('pack-s', { event: 'snapshot', player: null, online: [target] });
  assert.equal((await store.get(op._id))?.state, 'dispatched');
});

test('dispatcher: sweep expires ops past expiresAt', async () => {
  const port = mkPort();
  const d = new OpDispatcher(store, port);

  const { op } = await store.create(mkInput('pack-e', { expiresInMs: 60_000 }));
  await d.sweep(new Date(Date.now() + 120_000));
  assert.equal((await store.get(op._id))?.state, 'expired');
});

test('dispatcher: ops bit OFF is the rollback lever — op queues, never dispatches, burns no attempts', async () => {
  const port = mkPort();
  const d = new OpDispatcher(store, port);
  port.live.add('pack-gated'); // live link, but NO ops grant

  const { op } = await store.create(mkInput('pack-gated'));
  await d.onOpCreated(op);
  await d.onLinkUp('pack-gated');
  await d.sweep(new Date(Date.now() + 60_000));

  const after = await store.get(op._id);
  assert.equal(after?.state, 'pending', 'stays queued with the bit off');
  assert.equal(after?.attempts, 0, 'no dispatch attempts burned');
  assert.equal(port.sent.length, 0, 'nothing hit the wire');

  // granting the bit releases the queue on the next link-up/sweep
  await grantOps('pack-gated');
  await d.onLinkUp('pack-gated');
  assert.equal((await store.get(op._id))?.state, 'dispatched');
  assert.equal(port.sent.length, 1);
});

test('dispatcher: sweep fails an acked op whose result never arrives', async () => {
  const port = mkPort();
  const d = new OpDispatcher(store, port);
  port.live.add('pack-t');

  const { op } = await store.create(mkInput('pack-t', { execTimeoutMs: 1_000 }));
  await d.onLinkUp('pack-t');
  await d.onOpRes('pack-t', { opId: op._id, phase: 'ack' });
  await d.sweep(new Date(Date.now() + 30_000));
  const failed = await store.get(op._id);
  assert.equal(failed?.state, 'failed');
  assert.match(failed?.result?.error ?? '', /no result within/);
});
