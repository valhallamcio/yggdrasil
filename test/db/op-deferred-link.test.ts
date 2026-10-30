import '../helpers/env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

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
  assert.equal(a.state.open, false, 'the old session is evicted');
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
  assert.equal(lm.opSessionFor('arc'), 'arc#4');
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
