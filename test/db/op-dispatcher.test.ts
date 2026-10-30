import '../helpers/env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestMongo, type TestMongo } from '../helpers/mongo.ts';
import { DEFERRED_NOTE, MAX_DEFERRALS, OpsStore } from '../../src/plugins/biforesting-link/ops-store.ts';
import { OpDispatcher, OP_CHANNEL } from '../../src/plugins/biforesting-link/op-dispatcher.ts';
import { decodeJsonPayload } from '../../src/plugins/biforesting-link/decoders.ts';
import { setPolicy, setPolicyDbProvider, maskForFeatures } from '../../src/plugins/biforesting-link/policy-store.ts';
import { classifyOp, provablyUnrun } from '../../src/plugins/biforesting-link/sync-runner.ts';
import type { OpResMsg } from '../../src/plugins/biforesting-link/types.ts';

let mongo: TestMongo;
let store: OpsStore;
let seq = 0;

/** Dispatch is policy-gated: grant the ops bit for an instance under test. */
async function grantOps(instanceKey: string): Promise<void> {
  await setPolicy(instanceKey, { enabledFeatures: maskForFeatures(['play_transport', 'ops']) }, 'test');
}

/**
 * Capturing fake of the link manager: records DOWN sends, per-instance liveness switch. The
 * session id of a live instance is the instanceKey until a test names a new one in `sessions`
 * (the next JVM). A session in `stopping` takes no op. `failWrites` drops every write.
 */
function mkPort() {
  const sent: Array<{ instanceKey: string; sessionId: string; channel: string; body: Record<string, unknown> }> = [];
  const live = new Set<string>();
  const sessions = new Map<string, string>();
  const stopping = new Set<string>();
  const sessionOf = (instanceKey: string): string => sessions.get(instanceKey) ?? instanceKey;
  const port = {
    sent,
    live,
    sessions,
    stopping,
    failWrites: false,
    sessionFor: (instanceKey: string) => {
      const sessionId = sessionOf(instanceKey);
      return live.has(instanceKey) && !stopping.has(sessionId) ? sessionId : null;
    },
    sendDown: (sessionId: string, channel: string, payload: Buffer) => {
      const instanceKey = [...live].find((k) => sessionOf(k) === sessionId);
      if (port.failWrites || instanceKey === undefined || stopping.has(sessionId)) return false;
      sent.push({ instanceKey, sessionId, channel, body: decodeJsonPayload(payload) as Record<string, unknown> });
      return true;
    },
    liveInstanceKeys: () => [...live].filter((k) => !stopping.has(sessionOf(k))),
  };
  return port;
}

function deferred(opId: string): OpResMsg {
  return { opId, phase: 'result', status: 'deferred', code: 'server_stopping' };
}

before(async () => {
  mongo = await startTestMongo();
  store = new OpsStore(() => mongo.client.db('ygg_dispatch_test'));
  setPolicyDbProvider(() => mongo.client.db('ygg_dispatch_test'));
  for (const key of ['pack-a', 'pack-down', 'pack-b', 'pack-c', 'pack-evil', 'pack-f', 'pack-w', 'pack-s', 'pack-e', 'pack-t']) {
    await grantOps(key);
  }
  for (const key of ['defer-a', 'defer-b', 'defer-c', 'defer-d', 'defer-e', 'defer-f', 'defer-g', 'defer-h', 'defer-i']) await grantOps(key);
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

test('dispatcher: op for a dead link stays pending, a failed write eagerly rolls back; link-up redelivers', async () => {
  const port = mkPort();
  const d = new OpDispatcher(store, port);

  const { op } = await store.create(mkInput('pack-down'));
  await d.onOpCreated(op);
  const untouched = await store.get(op._id);
  assert.equal(untouched?.state, 'pending', 'no session: the op is not touched');
  assert.equal(untouched?.attempts, 0);

  // The session was picked but the write failed. Link-up redispatch only considers `pending`
  // (a stranded `dispatched` would wait for the sweep), so the op rolls back at once.
  port.live.add('pack-down');
  port.failWrites = true;
  await d.onLinkUp('pack-down');
  const rolledBack = await store.get(op._id);
  assert.equal(rolledBack?.state, 'pending', 'eagerly requeued');
  assert.match(rolledBack?.audit.at(-1)?.note ?? '', /^link not writable/);

  port.failWrites = false;
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

// ── deferred: the server stops and did not run the op ──────────────────────

test('deferred: the session the op went to answers; back to pending, no attempt, code kept; the next session gets it', async () => {
  const port = mkPort();
  const d = new OpDispatcher(store, port);
  port.live.add('defer-a');

  const { op } = await store.create(mkInput('defer-a'));
  await d.onLinkUp('defer-a');
  assert.equal((await store.get(op._id))?.dispatchSessionId, 'defer-a');

  // The link manager marks the session stopping before it routes the answer.
  port.stopping.add('defer-a');
  await d.onOpRes('defer-a', deferred(op._id), 'defer-a');
  const back = await store.get(op._id);
  assert.equal(back?.state, 'pending');
  assert.equal(back?.attempts, 0, 'a deferral is no attempt');
  assert.equal(back?.deferrals, 1);
  const entry = back?.audit.at(-1);
  assert.deepEqual([entry?.from, entry?.to, entry?.code], ['dispatched', 'pending', 'server_stopping']);
  assert.ok(entry?.note?.startsWith(DEFERRED_NOTE));
  assert.equal(port.sent.length, 1, 'the stopping session gets nothing again');

  await d.sweep(new Date(Date.now() + 60_000));
  assert.equal((await store.get(op._id))?.state, 'pending', 'the sweep skips the stopping session');
  assert.equal(port.sent.length, 1);

  // The next JVM links as a new session. Its link-up sends the op.
  port.sessions.set('defer-a', 'defer-a#2');
  await d.onLinkUp('defer-a');
  const again = await store.get(op._id);
  assert.deepEqual([again?.state, again?.dispatchSessionId, again?.attempts], ['dispatched', 'defer-a#2', 1]);
  assert.equal(port.sent.at(-1)?.sessionId, 'defer-a#2');
});

test('deferred: a late answer from the old session sends the op to the newer session at once', async () => {
  const port = mkPort();
  const d = new OpDispatcher(store, port);
  port.live.add('defer-b');
  const { op } = await store.create(mkInput('defer-b'));
  await d.onLinkUp('defer-b');

  // The next JVM registers while the op is still dispatched to the old one: its link-up sends nothing.
  port.sessions.set('defer-b', 'defer-b#2');
  await d.onLinkUp('defer-b');
  assert.equal(port.sent.length, 1);

  port.stopping.add('defer-b');
  await d.onOpRes('defer-b', deferred(op._id), 'defer-b');
  const moved = await store.get(op._id);
  assert.deepEqual([moved?.state, moved?.dispatchSessionId, moved?.attempts, moved?.deferrals], ['dispatched', 'defer-b#2', 1, 1]);
  assert.equal(port.sent.at(-1)?.sessionId, 'defer-b#2');
});

test('deferred: an answer from another session changes nothing', async () => {
  const port = mkPort();
  const d = new OpDispatcher(store, port);
  port.live.add('defer-c');
  const { op } = await store.create(mkInput('defer-c'));
  await d.onLinkUp('defer-c');
  const sent = await store.get(op._id);

  await d.onOpRes('defer-c', deferred(op._id), 'defer-c#old');
  await d.onOpRes('defer-c', deferred(op._id));
  // The right session, but a code other than server_stopping: not a stop, so no change either.
  await d.onOpRes('defer-c', { ...deferred(op._id), code: 'world_save' }, 'defer-c');
  await d.onOpRes('defer-c', { opId: op._id, phase: 'result', status: 'deferred' }, 'defer-c');
  const after = await store.get(op._id);
  assert.deepEqual([after?.state, after?.dispatchSessionId, after?.attempts], ['dispatched', 'defer-c', 1]);
  assert.equal(after?.deferrals, undefined);
  assert.equal(after?.audit.length, sent?.audit.length);
});

test('deferred: an op acked before the stop whose task never started goes back to pending, counted as not run', async () => {
  const port = mkPort();
  const d = new OpDispatcher(store, port);
  port.live.add('defer-d');
  const { op } = await store.create(mkInput('defer-d'));
  // One unwritable dispatch first, so the attempt count stays above 0 and provablyUnrun reads the audit.
  port.failWrites = true;
  await d.onLinkUp('defer-d');
  port.failWrites = false;
  await d.onLinkUp('defer-d');
  await d.onOpRes('defer-d', { opId: op._id, phase: 'ack' });

  // The mod acked, then the stop dropped the queued task and answered `deferred`.
  port.stopping.add('defer-d');
  await d.onOpRes('defer-d', deferred(op._id), 'defer-d');
  const back = await store.get(op._id);
  assert.deepEqual([back?.state, back?.attempts, back?.deferrals, back?.ackedAt], ['pending', 1, 1, null]);
  assert.deepEqual([back?.audit.at(-1)?.from, back?.audit.at(-1)?.code], ['acked', 'server_stopping']);
  assert.equal(provablyUnrun(back!), true, 'ack then deferral: the task never started');

  port.sessions.set('defer-d', 'defer-d#2');
  await d.onLinkUp('defer-d');
  assert.deepEqual([(await store.get(op._id))?.state, port.sent.at(-1)?.sessionId], ['dispatched', 'defer-d#2']);
});

test('deferred: a timed-out (pending again) op stays as it is', async () => {
  const port = mkPort();
  const d = new OpDispatcher(store, port);
  port.live.add('defer-h');
  // The sweep requeued a dispatch that timed out. A late deferral of that dispatch changes nothing.
  const { op } = await store.create(mkInput('defer-h', { dispatchTimeoutMs: 1_000 }));
  await d.onLinkUp('defer-h');
  port.live.delete('defer-h');
  await d.sweep(new Date(Date.now() + 5_000));
  const requeued = await store.get(op._id);
  assert.equal(requeued?.state, 'pending');
  await d.onOpRes('defer-h', deferred(op._id), 'defer-h');
  const p = await store.get(op._id);
  assert.deepEqual([p?.state, p?.attempts, p?.deferrals], ['pending', 1, undefined]);
  assert.equal(p?.audit.length, requeued?.audit.length);
});

test('deferred: the exec-timeout sweep acts only on the ack it read', async () => {
  const port = mkPort();
  const d = new OpDispatcher(store, port);
  port.live.add('defer-i');
  const { op } = await store.create(mkInput('defer-i', { execTimeoutMs: 1_000 }));
  await d.onLinkUp('defer-i');
  await d.onOpRes('defer-i', { opId: op._id, phase: 'ack' });
  const stale = (await store.findStaleAcked(new Date(Date.now() + 5_000))).find((o) => o._id === op._id);
  assert.ok(stale, 'the sweep read the ack as timed out');

  // The deferral lands between the sweep's read and its write.
  port.stopping.add('defer-i');
  await d.onOpRes('defer-i', deferred(op._id), 'defer-i');
  assert.equal(await store.failStaleAcked(stale), null, 'the stale read does not fail the requeued op');
  const kept = await store.get(op._id);
  assert.deepEqual([kept?.state, kept?.result], ['pending', null]);
});

test(`deferred: deferral ${MAX_DEFERRALS} fails the op with too_many_deferrals; it never ran`, async () => {
  const port = mkPort();
  const d = new OpDispatcher(store, port);
  port.live.add('defer-e');
  const { op } = await store.create(mkInput('defer-e'));
  for (let i = 1; i <= MAX_DEFERRALS; i++) {
    const sessionId = `defer-e#${i}`;
    port.sessions.set('defer-e', sessionId);
    await d.onLinkUp('defer-e');
    assert.equal((await store.get(op._id))?.dispatchSessionId, sessionId);
    port.stopping.add(sessionId);
    await d.onOpRes('defer-e', deferred(op._id), sessionId);
    if (i < MAX_DEFERRALS) assert.equal((await store.get(op._id))?.state, 'pending', `deferral ${i} requeues`);
  }
  const failed = await store.get(op._id);
  assert.equal(failed?.state, 'failed');
  assert.equal(failed?.result?.code, 'too_many_deferrals');
  assert.deepEqual([failed?.deferrals, failed?.attempts], [MAX_DEFERRALS, 0]);
  assert.equal(port.sent.length, MAX_DEFERRALS);
  const c = classifyOp(failed!);
  assert.deepEqual([c.kind, c.kind === 'not_applied' ? c.code : null], ['not_applied', 'too_many_deferrals']);
});

test('deferred: the sweep acts only on the dispatch it read', async () => {
  const port = mkPort();
  const d = new OpDispatcher(store, port);
  port.live.add('defer-f');
  const { op } = await store.create(mkInput('defer-f', { maxAttempts: 1, dispatchTimeoutMs: 1_000 }));
  await d.onLinkUp('defer-f');
  const stale = (await store.findStaleDispatched(new Date(Date.now() + 5_000))).find((o) => o._id === op._id);
  assert.ok(stale, 'the sweep read the dispatch as timed out');

  // The deferral lands between the sweep's read and its write. Before, the stale read failed the op.
  port.stopping.add('defer-f');
  await d.onOpRes('defer-f', deferred(op._id), 'defer-f');
  assert.equal(await store.requeueOrFail(stale), null, 'the stale read neither fails nor requeues');
  const kept = await store.get(op._id);
  assert.deepEqual([kept?.state, kept?.result], ['pending', null]);

  // A new dispatch with the same attempt count is not the dispatch the sweep read either.
  await new Promise((resolve) => setTimeout(resolve, 5));
  port.sessions.set('defer-f', 'defer-f#2');
  await d.onLinkUp('defer-f');
  assert.equal((await store.get(op._id))?.attempts, stale.attempts);
  assert.equal(await store.requeueOrFail(stale), null);
  assert.equal((await store.get(op._id))?.state, 'dispatched');
});

test('deferred: provablyUnrun counts a deferred dispatch as not run', async () => {
  const port = mkPort();
  const d = new OpDispatcher(store, port);
  const { op } = await store.create(mkInput('defer-g'));
  port.live.add('defer-g');
  port.failWrites = true;
  await d.onLinkUp('defer-g');
  port.failWrites = false;
  await d.onLinkUp('defer-g');
  port.stopping.add('defer-g');
  await d.onOpRes('defer-g', deferred(op._id), 'defer-g');
  const once = await store.get(op._id);
  assert.equal(once?.attempts, 1, 'the unwritable dispatch keeps its attempt');
  assert.equal(provablyUnrun(once!), true);

  port.sessions.set('defer-g', 'defer-g#2');
  await d.onLinkUp('defer-g');
  assert.equal(provablyUnrun((await store.get(op._id))!), false, 'the new session may run it');
});
