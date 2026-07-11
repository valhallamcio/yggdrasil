import '../helpers/env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestMongo, type TestMongo } from '../helpers/mongo.ts';
import { OpsStore } from '../../src/plugins/biforesting-link/ops-store.ts';
import { OpDispatcher } from '../../src/plugins/biforesting-link/op-dispatcher.ts';
import { CompoundOps, accountResetChildren } from '../../src/plugins/biforesting-link/compound-ops.ts';
import { decodeJsonPayload } from '../../src/plugins/biforesting-link/decoders.ts';
import { setPolicy, setPolicyDbProvider, maskForFeatures } from '../../src/plugins/biforesting-link/policy-store.ts';
import type { OpDoc } from '../../src/plugins/biforesting-link/types.ts';

let mongo: TestMongo;
let store: OpsStore;

function mkPort() {
  const sent: Array<{ instanceKey: string; body: Record<string, unknown> }> = [];
  const live = new Set<string>();
  return {
    sent,
    live,
    sendDown: (instanceKey: string, _channel: string, payload: Buffer) => {
      if (!live.has(instanceKey)) return false;
      sent.push({ instanceKey, body: decodeJsonPayload(payload) as Record<string, unknown> });
      return true;
    },
    liveInstanceKeys: () => [...live],
  };
}

function mkStack(instanceKey: string) {
  const port = mkPort();
  port.live.add(instanceKey);
  const dispatcher = new OpDispatcher(store, port);
  const compound = new CompoundOps(store, dispatcher);
  dispatcher.setUpdateHook((op) => compound.onChildUpdate(op));
  return { port, dispatcher, compound };
}

async function mkParent(instanceKey: string, params: Record<string, unknown> = {}): Promise<OpDoc> {
  const { op } = await store.create({
    instanceKey,
    serverTag: instanceKey,
    type: 'account_reset',
    params,
    target: { uuid: '00000000-0000-0000-0000-000000000001', name: 'Victim' },
    flags: { compound: true },
    createdBy: 'test',
  });
  return op;
}

/** Poll until `cond` holds — fixed settle sleeps flaked under CPU load (parallel gradle builds). */
async function waitFor(cond: () => Promise<boolean> | boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const PARENT_TERMINAL = new Set(['completed', 'failed', 'cancelled', 'expired']);

/**
 * The mod side of one child: ack + result, driving the chain like a real backend. The compound
 * update hook is fire-and-forget, so wait for its observable effect — the next child hitting the
 * wire, or the parent going terminal after the last one.
 */
async function completeChild(stack: ReturnType<typeof mkStack>, instanceKey: string, opId: string, parentId: string) {
  const sentBefore = stack.port.sent.length;
  await stack.dispatcher.onOpRes(instanceKey, { opId, phase: 'ack' });
  await stack.dispatcher.onOpRes(instanceKey, { opId, phase: 'result', status: 'completed', result: { ok: 1 } });
  await waitFor(async () => {
    if (stack.port.sent.length > sentBefore) return true;
    const p = await store.get(parentId);
    return PARENT_TERMINAL.has(p?.state ?? '');
  }, `chain reaction after child ${opId}`);
}

before(async () => {
  mongo = await startTestMongo();
  store = new OpsStore(() => mongo.client.db('ygg_compound_test'));
  setPolicyDbProvider(() => mongo.client.db('ygg_compound_test'));
  for (const key of ['pack-a', 'pack-f', 'pack-r', 'pack-w', 'pack-d']) {
    await setPolicy(key, { enabledFeatures: maskForFeatures(['play_transport', 'ops']) }, 'test');
  }
});
after(async () => mongo.stop());

test('compound: child specs follow D15 (transfer default, release opt-out)', () => {
  const def = accountResetChildren({});
  assert.deepEqual(def.map((c) => c.type), ['inspect_inventory', 'quest_reset', 'claims_transfer', 'team_reset', 'inventory_clear']);
  assert.equal(def[2]?.params['holdTeam'], 'valhallamc');
  const rel = accountResetChildren({ claims: 'release', holdTeam: 'ignored' });
  assert.equal(rel[2]?.type, 'claims_release');
});

test('compound: children run strictly one at a time, parent completes after the last', async () => {
  const stack = mkStack('pack-a');
  const parent = await mkParent('pack-a');
  await stack.compound.expand(parent);

  const specs = accountResetChildren({});
  for (let i = 0; i < specs.length; i++) {
    assert.equal(stack.port.sent.length, i + 1, `exactly one new dispatch per completed child (step ${i})`);
    const wire = stack.port.sent[i]!;
    assert.equal(wire.body['type'], specs[i]!.type, `child ${i} type`);
    await completeChild(stack, 'pack-a', wire.body['opId'] as string, parent._id);
  }

  const done = await store.get(parent._id);
  assert.equal(done?.state, 'completed');
  const summary = (done?.result as { data?: { children?: Array<{ state: string }> } })?.data;
  assert.equal(summary?.children?.length, specs.length);
  assert.ok(summary?.children?.every((c) => c.state === 'completed'));
  // parent itself never went down the wire
  assert.ok(stack.port.sent.every((w) => w.body['type'] !== 'account_reset'));
});

test('compound: child failure fails the parent at the checkpoint; resume respawns ONLY the failed step', async () => {
  const stack = mkStack('pack-f');
  const parent = await mkParent('pack-f');
  await stack.compound.expand(parent);

  // child 0 completes, child 1 (quest_reset) fails
  await completeChild(stack, 'pack-f', stack.port.sent[0]!.body['opId'] as string, parent._id);
  const child1Id = stack.port.sent[1]!.body['opId'] as string;
  await stack.dispatcher.onOpRes('pack-f', { opId: child1Id, phase: 'ack' });
  await stack.dispatcher.onOpRes('pack-f', { opId: child1Id, phase: 'result', status: 'failed', error: 'FTBQ absent' });
  await waitFor(async () => (await store.get(parent._id))?.state === 'failed', 'parent checkpoints');

  let p = await store.get(parent._id);
  assert.equal(p?.state, 'failed');
  assert.match((p?.result as { error?: string })?.error ?? '', /child 1/);
  assert.equal(stack.port.sent.length, 2, 'chain stopped at the checkpoint');

  // resume: child 0 is NOT re-run, a fresh quest_reset child is spawned
  const resumed = await stack.compound.resume(parent._id);
  assert.equal(resumed?.state, 'pending');
  assert.equal(stack.port.sent.length, 3);
  assert.equal(stack.port.sent[2]!.body['type'], 'quest_reset');
  assert.notEqual(stack.port.sent[2]!.body['opId'], child1Id, 'fresh op, failed one stays for audit');

  // drive the rest to completion
  for (let i = 2; i < stack.port.sent.length && stack.port.sent.length <= 6; i++) {
    await completeChild(stack, 'pack-f', stack.port.sent[i]!.body['opId'] as string, parent._id);
  }
  assert.equal((await store.get(parent._id))?.state, 'completed');
});

test('compound: waiting_player child stalls the chain without failing the parent', async () => {
  const stack = mkStack('pack-w');
  const parent = await mkParent('pack-w');
  await stack.compound.expand(parent);

  const child0Id = stack.port.sent[0]!.body['opId'] as string;
  await stack.dispatcher.onOpRes('pack-w', { opId: child0Id, phase: 'ack' });
  await stack.dispatcher.onOpRes('pack-w', { opId: child0Id, phase: 'result', status: 'waiting_player' });
  // Negative assertion (nothing should advance) — a settle sleep is the only option here.
  await new Promise((r) => setTimeout(r, 50));

  assert.equal((await store.get(parent._id))?.state, 'pending', 'parent keeps waiting');
  assert.equal(stack.port.sent.length, 1, 'no premature next child');

  // the player joins → presence requeues the child → chain continues
  await stack.dispatcher.onPresence('pack-w', {
    event: 'join',
    player: { uuid: '00000000-0000-0000-0000-000000000001', name: 'Victim' },
    online: null,
  });
  assert.equal(stack.port.sent.length, 2, 'parked child redispatched');
  assert.equal(stack.port.sent[1]!.body['opId'], child0Id, 'same child op resumes');
});

test('compound: resume rejects non-compound and non-failed ops', async () => {
  const stack = mkStack('pack-r');
  const { op: plain } = await store.create({
    instanceKey: 'pack-r',
    serverTag: 'pack-r',
    type: 'echo',
    params: {},
    createdBy: 'test',
  });
  assert.equal(await stack.compound.resume(plain._id), null, 'plain op is not resumable');

  const parent = await mkParent('pack-r');
  await stack.compound.expand(parent);
  assert.equal(await stack.compound.resume(parent._id), null, 'pending parent is not resumable');
});

test('compound: REST-style cancel of a child checkpoints the parent (the controller calls onChildUpdate)', async () => {
  const stack = mkStack('pack-d');
  const parent = await mkParent('pack-d');
  await stack.compound.expand(parent);

  const childId = stack.port.sent[0]!.body['opId'] as string;
  const cancelled = await store.cancel(childId, 'test');
  assert.ok(cancelled);
  await stack.compound.onChildUpdate(cancelled); // what cancelOp does after a successful cancel

  const p = await store.get(parent._id);
  assert.equal(p?.state, 'failed');
  assert.match((p?.result as { error?: string })?.error ?? '', /child 0/);

  // and the resume path revives it with a fresh child 0
  const resumed = await stack.compound.resume(parent._id);
  assert.equal(resumed?.state, 'pending');
  assert.equal(stack.port.sent.length, 2);
  assert.notEqual(stack.port.sent[1]!.body['opId'], childId);
});

test('compound: parent never appears in findDispatchable', async () => {
  const parent = await mkParent('pack-d');
  const dispatchable = await store.findDispatchable('pack-d');
  assert.ok(dispatchable.every((op) => op._id !== parent._id), 'compound parents are never wire-dispatched');
});
