import '../helpers/env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

import { startTestMongo, type TestMongo } from '../helpers/mongo.ts';
import { Writer } from '../../src/plugins/biforesting-link/frame-codec.ts';
import { encodeJsonPayload } from '../../src/plugins/biforesting-link/decoders.ts';

/**
 * `deferred` end to end through the production wiring: link manager sessions, the server resolver
 * (PRI-style tag groups from `bifrost.servers`), the ops runtime and the policy store. The app
 * modules load after the global Mongo client points at mem-mongo.
 */

type LinkManager = (typeof import('../../src/plugins/biforesting-link/link-manager.ts'))['biforestingLinkManager'];
type OpsRuntime = typeof import('../../src/plugins/biforesting-link/ops-runtime.ts');

let mongo: TestMongo;
let lm: LinkManager;
let ops: OpsRuntime;
let disconnect: () => Promise<void>;

function register(serverId: string, bootNonce: bigint): Buffer {
  return new Writer().varInt(2).utf(serverId).utf('test').varInt(0x80c10).utf('node').utf('10.0.0.1:25565').long(bootNonce).varInt(2).build();
}

/** A fake link transport. It keeps the channel of every DOWN unit. */
function transport() {
  const state = { open: true, channels: [] as string[] };
  return {
    state,
    t: {
      writable: () => state.open,
      send: (unit: Buffer) => {
        state.channels.push(unit.subarray(2, 2 + unit.readUInt16BE(0)).toString('utf8'));
      },
      close: () => {
        state.open = false;
      },
    },
  };
}

function opSends(x: { state: { channels: string[] } }): number {
  return x.state.channels.filter((c) => c === 'biforesting:op').length;
}

function opRes(body: Record<string, unknown>): Buffer {
  return encodeJsonPayload(JSON.stringify(body));
}

async function createOp(instanceKey: string): Promise<string> {
  const { op } = await ops.opsStore.create({
    instanceKey,
    serverTag: instanceKey.split(':')[0]!,
    type: 'echo',
    params: { message: 'hi' },
    createdBy: 'test',
  });
  await ops.opDispatcher.onOpCreated(op);
  return op._id;
}

async function defer(sessionId: string, opId: string): Promise<void> {
  await lm.dispatch(sessionId, 'biforesting:op_res', opRes({ opId, phase: 'result', status: 'deferred', code: 'server_stopping' }));
}

function stoppingOf(sessionId: string): boolean | undefined {
  return lm.getSnapshot().sessions.find((s) => s.sessionId === sessionId)?.stopping;
}

function request(params: Record<string, string>, body: Record<string, unknown>): Request {
  return { params, body, headers: {} } as unknown as Request;
}

function response(): Response & { code?: number; body?: unknown } {
  const res = {
    code: undefined as number | undefined,
    body: undefined as unknown,
    status(code: number) {
      res.code = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res as unknown as Response & { code?: number; body?: unknown };
}

before(async () => {
  mongo = await startTestMongo();
  process.env.MONGODB_URI = mongo.uri;
  process.env.MONGODB_DB_NAME = 'ygg_op_deferred_test';
  await mongo.client.db('bifrost').collection('servers').insertMany([
    { tag: 'pri', serverId: '076d8208', name: 'Prominence 1', group: 'pri', instanceNumber: 1 },
    { tag: 'pri', serverId: '1ae705e3', name: 'Prominence 2', group: 'pri', instanceNumber: 2 },
    { tag: 'arc', serverId: 'a0000001', name: 'Arcadia', group: '' },
  ]);
  const client = await import('../../src/core/database/client.ts');
  await client.connectDatabase();
  disconnect = client.disconnectDatabase;
  lm = (await import('../../src/plugins/biforesting-link/link-manager.ts')).biforestingLinkManager;
  ops = await import('../../src/plugins/biforesting-link/ops-runtime.ts');
  const policy = await import('../../src/plugins/biforesting-link/policy-store.ts');
  const grant = policy.maskForFeatures(['play_transport', 'ops']);
  for (const key of ['arc', 'pri', 'pri:076d8208', 'pri:1ae705e3']) await policy.setPolicy(key, { enabledFeatures: grant }, 'test');
  lm.setOpSink(ops.opDispatcher);
});

after(async () => {
  lm.setOpSink(null);
  lm.closeAll();
  await disconnect();
  await mongo.stop();
});

test('deferred over the link: the stopping session gets no op; the next JVM gets them at its link-up', async () => {
  const a = transport();
  lm.registerSession('arc#1', a.t, '10.0.0.3:1');
  await lm.dispatch('arc#1', 'biforesting:register', register('a0000001', 1n));
  const first = await createOp('arc');
  assert.equal(opSends(a), 1);
  assert.equal((await ops.opsStore.get(first))?.dispatchSessionId, 'arc#1');

  await defer('arc#1', first);
  assert.equal(stoppingOf('arc#1'), true);
  const back = await ops.opsStore.get(first);
  assert.deepEqual([back?.state, back?.attempts, back?.deferrals], ['pending', 0, 1]);
  assert.equal(lm.liveInstanceKeys().includes('arc'), false);
  assert.equal(lm.opSessionFor('arc'), null);

  const second = await createOp('arc');
  await ops.opDispatcher.sweep();
  assert.equal(opSends(a), 1, 'nothing goes to the stopping JVM');
  assert.equal((await ops.opsStore.get(second))?.state, 'pending');

  const b = transport();
  lm.registerSession('arc#2', b.t, '10.0.0.3:2');
  await lm.dispatch('arc#2', 'biforesting:register', register('a0000001', 2n));
  assert.equal(stoppingOf('arc#1'), undefined, 'the old session is replaced');
  assert.equal(stoppingOf('arc#2'), false);
  assert.equal(opSends(b), 2, 'both ops go out at the link-up');
  for (const id of [first, second]) {
    const op = await ops.opsStore.get(id);
    assert.deepEqual([op?.state, op?.dispatchSessionId], ['dispatched', 'arc#2']);
  }
  lm.removeSession('arc#2');
});

test('deferred over the link: a closed stopping session leaves no flag; the next session takes ops', async () => {
  const a = transport();
  lm.registerSession('arc#3', a.t, '10.0.0.3:3');
  await lm.dispatch('arc#3', 'biforesting:register', register('a0000001', 3n));
  const id = await createOp('arc');
  await defer('arc#3', id);
  assert.equal(stoppingOf('arc#3'), true);

  a.t.close();
  lm.removeSession('arc#3');
  assert.equal(lm.getSnapshot().sessions.some((s) => s.stopping), false);

  const b = transport();
  lm.registerSession('arc#4', b.t, '10.0.0.3:4');
  await lm.dispatch('arc#4', 'biforesting:register', register('a0000001', 4n));
  assert.equal(lm.opSessionFor('arc')?.sessionId, 'arc#4');
  assert.equal(opSends(b), 1);
  assert.equal((await ops.opsStore.get(id))?.dispatchSessionId, 'arc#4');
  lm.removeSession('arc#4');
});

test('deferred over the link: PRI-style tag collision; one instance stopping never touches the other', async () => {
  const p1 = transport();
  const p2 = transport();
  lm.registerSession('pri1', p1.t, '10.0.0.1:1');
  lm.registerSession('pri2', p2.t, '10.0.0.2:1');
  await lm.dispatch('pri1', 'biforesting:register', register('076d8208', 11n));
  await lm.dispatch('pri2', 'biforesting:register', register('1ae705e3', 21n));
  assert.equal(lm.opSessionFor('pri'), null, 'a tag never picks a session');

  const onPri1 = await createOp('pri:076d8208');
  const onPri2 = await createOp('pri:1ae705e3');
  assert.deepEqual([opSends(p1), opSends(p2)], [1, 1]);

  // PRI#1 stops. Its deferral of PRI#2's op changes nothing.
  await defer('pri1', onPri1);
  await defer('pri1', onPri2);
  assert.deepEqual([stoppingOf('pri1'), stoppingOf('pri2')], [true, false]);
  assert.equal(lm.liveInstance('076d8208'), null, 'player sync sees the stopping PRI#1 as not reachable');
  assert.equal(lm.liveInstance('1ae705e3')?.instanceKey, 'pri:1ae705e3');
  assert.equal((await ops.opsStore.get(onPri1))?.state, 'pending');
  const other = await ops.opsStore.get(onPri2);
  assert.deepEqual([other?.state, other?.dispatchSessionId, other?.deferrals], ['dispatched', 'pri2', undefined]);
  assert.deepEqual(lm.liveInstanceKeys().filter((k) => k.startsWith('pri')), ['pri:1ae705e3']);

  const next = await createOp('pri:1ae705e3');
  const byTag = await createOp('pri');
  await ops.opDispatcher.sweep();
  assert.deepEqual([opSends(p1), opSends(p2)], [1, 2], 'PRI#2 takes its op; PRI#1 and the tag op get nothing');
  assert.equal((await ops.opsStore.get(next))?.dispatchSessionId, 'pri2');
  assert.equal((await ops.opsStore.get(byTag))?.state, 'pending');
  assert.equal((await ops.opsStore.get(onPri1))?.state, 'pending', 'the PRI#1 op waits for the next PRI#1 JVM');

  await lm.dispatch('pri2', 'biforesting:op_res', opRes({ opId: onPri2, phase: 'ack' }));
  await lm.dispatch('pri2', 'biforesting:op_res', opRes({ opId: onPri2, phase: 'result', status: 'completed', result: {} }));
  assert.equal((await ops.opsStore.get(onPri2))?.state, 'completed');
  lm.removeSession('pri1');
  lm.removeSession('pri2');
});

test('deferred over the link: a code other than server_stopping marks no session stopping', async () => {
  const a = transport();
  lm.registerSession('arc#5', a.t, '10.0.0.3:5');
  await lm.dispatch('arc#5', 'biforesting:register', register('a0000001', 5n));
  const id = await createOp('arc');
  await lm.dispatch('arc#5', 'biforesting:op_res', opRes({ opId: id, phase: 'result', status: 'deferred', code: 'world_save' }));
  await lm.dispatch('arc#5', 'biforesting:op_res', opRes({ opId: id, phase: 'result', status: 'deferred', code: 7 }));
  assert.equal(stoppingOf('arc#5'), false);
  assert.equal(lm.opSessionFor('arc')?.sessionId, 'arc#5');
  const op = await ops.opsStore.get(id);
  assert.deepEqual([op?.state, op?.dispatchSessionId, op?.deferrals], ['dispatched', 'arc#5', undefined]);
  lm.removeSession('arc#5');
});

test('deferred over the link: the old JVM still answers after the next JVM registered; its deferral moves the op over', async () => {
  const a = transport();
  lm.registerSession('arc#6', a.t, '10.0.0.3:6');
  await lm.dispatch('arc#6', 'biforesting:register', register('a0000001', 6n));
  const queued = await createOp('arc');
  await lm.dispatch('arc#6', 'biforesting:op_res', opRes({ opId: queued, phase: 'ack' }));
  const early = await createOp('arc');
  await defer('arc#6', early);
  assert.equal(stoppingOf('arc#6'), true);

  // The standby links before the old JVM drops its queue. The old session is not closed under it.
  const b = transport();
  lm.registerSession('arc#7', b.t, '10.0.0.3:7');
  await lm.dispatch('arc#7', 'biforesting:register', register('a0000001', 7n));
  assert.equal(a.state.open, true, 'a stopping session closes on its own');
  assert.deepEqual(
    lm.getSnapshot().sessions.filter((s) => s.identity?.instanceKey === 'arc').map((s) => s.sessionId),
    ['arc#7'],
    'only the new session holds the identity',
  );
  assert.equal((await ops.opsStore.get(early))?.dispatchSessionId, 'arc#7');

  // The old JVM drops the acked op from its queue and answers it `deferred`.
  await defer('arc#6', queued);
  const moved = await ops.opsStore.get(queued);
  assert.deepEqual([moved?.state, moved?.dispatchSessionId, moved?.ackedAt], ['dispatched', 'arc#7', null]);

  // Anything else from the old JVM is dropped: its presence would land on the new JVM's identity.
  const before = lm.getSnapshot().sessions.find((s) => s.sessionId === 'arc#7')?.framesAccepted;
  await lm.dispatch('arc#6', 'biforesting:presence', encodeJsonPayload(JSON.stringify({ event: 'snapshot', online: [] })));
  assert.equal(lm.getSnapshot().sessions.find((s) => s.sessionId === 'arc#7')?.framesAccepted, before);

  lm.removeSession('arc#6');
  assert.equal(lm.opSessionFor('arc')?.sessionId, 'arc#7', 'the old session closing leaves the new one alone');
  lm.removeSession('arc#7');
});

test('a session takes ops only after its reg_ack granted them: a hello alone gets none', async () => {
  const id = await createOp('arc');
  const a = transport();
  lm.registerSession('arc#8', a.t, '10.0.0.3:8');
  await lm.dispatch('arc#8', 'biforesting:hello', Buffer.from('a0000001', 'utf8'));
  assert.equal(lm.opSessionFor('arc'), null, 'the identity is known, but the mod has no grant yet');
  assert.equal(lm.liveInstance('a0000001'), null, 'player sync agrees with op dispatch');
  assert.equal(lm.isConnected('a0000001'), true, 'the server runs, so its players may be online');
  assert.equal(lm.isConnected('arc'), false, 'exact serverId only');
  await ops.opDispatcher.sweep();
  assert.deepEqual([(await ops.opsStore.get(id))?.state, opSends(a)], ['pending', 0]);

  await lm.dispatch('arc#8', 'biforesting:register', register('a0000001', 8n));
  const ackAt = a.state.channels.indexOf('biforesting:reg_ack');
  assert.ok(ackAt >= 0 && ackAt < a.state.channels.indexOf('biforesting:op'), 'the reg_ack goes out before the first op');
  assert.equal((await ops.opsStore.get(id))?.dispatchSessionId, 'arc#8');
  lm.removeSession('arc#8');
});

test('deferred over the link: the same JVM answers on a new connection; its deferral counts', async () => {
  const a = transport();
  lm.registerSession('arc#9', a.t, '10.0.0.3:9');
  await lm.dispatch('arc#9', 'biforesting:register', register('a0000001', 9n));
  const id = await createOp('arc');
  await lm.dispatch('arc#9', 'biforesting:op_res', opRes({ opId: id, phase: 'ack' }));

  // The connection drops before the stop. The same JVM links again with its boot nonce.
  a.t.close();
  lm.removeSession('arc#9');
  const again = transport();
  lm.registerSession('arc#10', again.t, '10.0.0.3:10');
  await lm.dispatch('arc#10', 'biforesting:register', register('a0000001', 9n));
  assert.equal(opSends(again), 0, 'the acked op is not sent again');

  // The stop drops the acked op from the queue and answers it `deferred` on the new connection.
  await defer('arc#10', id);
  assert.equal(stoppingOf('arc#10'), true);
  const back = await ops.opsStore.get(id);
  assert.deepEqual([back?.state, back?.attempts, back?.deferrals, back?.ackedAt], ['pending', 0, 1, null]);

  const b = transport();
  lm.registerSession('arc#11', b.t, '10.0.0.3:11');
  await lm.dispatch('arc#11', 'biforesting:register', register('a0000001', 11n));
  const moved = await ops.opsStore.get(id);
  assert.deepEqual([moved?.state, moved?.dispatchSessionId], ['dispatched', 'arc#11'], 'the next JVM gets it at its link-up');
  lm.removeSession('arc#10');
  lm.removeSession('arc#11');
});

test('GET inventory: a stopping session is not live; the stored snapshot answers at once and no op waits', async () => {
  const { BiforestingController } = await import('../../src/domains/biforesting/biforesting.controller.ts');
  const { NotFoundError } = await import('../../src/shared/errors/index.ts');
  const a = transport();
  lm.registerSession('arc#12', a.t, '10.0.0.3:12');
  await lm.dispatch('arc#12', 'biforesting:register', register('a0000001', 12n));
  await defer('arc#12', await createOp('arc'));
  assert.equal(stoppingOf('arc#12'), true);

  const inspects = async (): Promise<number> => (await ops.opsStore.list({ instanceKey: 'arc', type: 'inspect_inventory' }, 500)).length;
  const inspectsBefore = await inspects();
  const started = Date.now();
  await assert.rejects(new BiforestingController().getPlayerInventory(request({ server: 'arc', player: 'Steve' }, {}), response()), NotFoundError);
  assert.ok(Date.now() - started < 4_000, 'no wait for a live answer');
  assert.equal(await inspects(), inspectsBefore, 'no inspect op waits for the next JVM');
  lm.removeSession('arc#12');
});

test('POST /ops: a tag of several instances is refused; a one-instance tag and a serverId resolve', async () => {
  const { BiforestingController } = await import('../../src/domains/biforesting/biforesting.controller.ts');
  const { ProfilesController } = await import('../../src/domains/biforesting/profiles.controller.ts');
  const { ValidationError } = await import('../../src/shared/errors/index.ts');
  const c = new BiforestingController();
  const ambiguous = (err: unknown): boolean => err instanceof ValidationError && /several instances/.test(err.message);
  const echo = { type: 'echo', params: { message: 'hi' } };

  const byTag = (await ops.opsStore.list({ instanceKey: 'pri' }, 500)).length;
  await assert.rejects(c.createOp(request({ server: 'pri' }, echo), response()), ambiguous);
  await assert.rejects(new ProfilesController().createCapture(request({ server: 'pri' }, { seconds: 10, level: 'l1' }), response()), ambiguous);
  await assert.rejects(c.getPlayerInventory(request({ server: 'pri', player: 'Steve' }, {}), response()), ambiguous);
  assert.equal((await ops.opsStore.list({ instanceKey: 'pri' }, 500)).length, byTag, 'no op keyed by the tag');

  const single = response();
  await c.createOp(request({ server: 'arc' }, echo), single);
  assert.equal(single.code, 201);
  assert.equal((single.body as { data: { op: { instanceKey: string } } }).data.op.instanceKey, 'arc');

  const one = response();
  await c.createOp(request({ server: '1ae705e3' }, echo), one);
  assert.equal(one.code, 201);
  assert.equal((one.body as { data: { op: { instanceKey: string } } }).data.op.instanceKey, 'pri:1ae705e3');
});
