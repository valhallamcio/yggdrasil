import '../helpers/env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { startTestMongo, type TestMongo } from '../helpers/mongo.ts';
import { Writer } from '../../src/plugins/biforesting-link/frame-codec.ts';
import { encodeJsonPayload } from '../../src/plugins/biforesting-link/decoders.ts';

/**
 * Player sync S1 end to end through the production wiring: link manager channel switch, server
 * resolver groups from `bifrost.servers`, the sync runtime stores and the policy store. The app
 * modules are imported after the global Mongo client points at mem-mongo, because the server
 * resolver reads `bifrost.servers` through it.
 */

type LinkManager = (typeof import('../../src/plugins/biforesting-link/link-manager.ts'))['biforestingLinkManager'];
type SyncRuntime = typeof import('../../src/plugins/biforesting-link/sync-runtime.ts');

let mongo: TestMongo;
let lm: LinkManager;
let rt: SyncRuntime;
let disconnect: () => Promise<void>;

const FP = 'c'.repeat(64);
const STEVE = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';
const AT = 1_760_000_000_000;

function register(serverId: string, tail?: string): Buffer {
  const w = new Writer().varInt(2).utf(serverId).utf('evol').varInt(0x80c10).utf('node').utf('10.0.0.1:25565').long(1n).varInt(2);
  if (tail !== undefined) w.utf(tail);
  return w.build();
}

function syncTail(fp: string): string {
  return JSON.stringify({ fp, dv: 4790, mods: 312, items: 41829, cfg: 'd'.repeat(64) });
}

function syncsnap(uuid: string, gz: Buffer, sha = createHash('sha256').update(gz).digest('hex')): Buffer {
  const header = { kind: 'shadow', uuid, name: 'Steve', v: 0, fp: FP, dv: 4790, sha256: sha, gzLen: gz.length, blocked: [], links: [], worldData: [], playerData: [], at: AT };
  return Buffer.concat([new Writer().varInt(1).utf(JSON.stringify(header)).varInt(gz.length).build(), gz]);
}

function transport() {
  const state = { open: true, sends: 0 };
  return {
    state,
    t: {
      writable: () => state.open,
      send: () => {
        state.sends++;
      },
      close: () => {
        state.open = false;
      },
    },
  };
}

before(async () => {
  mongo = await startTestMongo();
  process.env.MONGODB_URI = mongo.uri;
  process.env.MONGODB_DB_NAME = 'ygg_sync_link_test';
  await mongo.client.db('bifrost').collection('servers').insertMany([
    { tag: 'evol', serverId: 'e7575fc9', name: 'Evolution 1', group: 'evol', instanceNumber: 1 },
    { tag: 'evol', serverId: '1ae705e3', name: 'Evolution 2', group: 'evol', instanceNumber: 2 },
    { tag: 'arc', serverId: 'a0000001', name: 'Arcadia', group: '' },
  ]);
  const client = await import('../../src/core/database/client.ts');
  await client.connectDatabase();
  disconnect = client.disconnectDatabase;
  lm = (await import('../../src/plugins/biforesting-link/link-manager.ts')).biforestingLinkManager;
  rt = await import('../../src/plugins/biforesting-link/sync-runtime.ts');
  const policy = await import('../../src/plugins/biforesting-link/policy-store.ts');
  const grant = policy.maskForFeatures(['play_transport', 'ops', 'presence', 'player_sync']);
  for (const key of ['evol:e7575fc9', 'evol:1ae705e3']) await policy.setPolicy(key, { enabledFeatures: grant }, 'test');
  await rt.ensureSyncIndexes();
  await rt.syncGroupsStore.upsert('evol', { mode: 'shadow' }, 'test');
  lm.setSyncSink(rt.syncService);
});

after(async () => {
  lm.setSyncSink(null);
  lm.closeAll();
  await disconnect();
  await mongo.stop();
});

test('sync link: register tail, presence ledger, syncsnap store, group status and shadow verdict', async () => {
  const a = transport();
  const b = transport();
  lm.registerSession('evo1', a.t, '10.0.0.1:1');
  lm.registerSession('evo2', b.t, '10.0.0.2:1');
  await lm.dispatch('evo1', 'biforesting:register', register('e7575fc9', syncTail(FP)));
  await lm.dispatch('evo2', 'biforesting:register', register('1ae705e3', syncTail(FP)));
  assert.ok(a.state.sends >= 1 && b.state.sends >= 1, 'both got a reg_ack');
  assert.equal(lm.getSessionSnapshot('e7575fc9')?.register?.sync?.fp, FP, 'GET /link shows the fingerprint');
  assert.equal(lm.liveInstance('e7575fc9')?.instanceKey, 'evol:e7575fc9');
  assert.equal(lm.liveInstance('evol'), null, 'a tag never matches');

  await lm.dispatch('evo1', 'biforesting:presence', encodeJsonPayload(JSON.stringify({ event: 'join', player: { uuid: STEVE, name: 'Steve', sync: { g: 'evol', v: 2 } } })));
  const doc = await rt.syncLedgerStore.get('evol', STEVE);
  assert.equal(doc?.owner, 'e7575fc9', 'owner is the Pterodactyl serverId, never the instanceKey');
  assert.equal(doc?.version, 2);
  assert.equal(doc?.shadow, true);

  await lm.dispatch('evo1', 'biforesting:syncsnap', syncsnap(STEVE, Buffer.from([31, 139, 1])));
  await lm.dispatch('evo1', 'biforesting:syncsnap', syncsnap('11111111-2222-3333-4444-555555555555', Buffer.from([1]), 'e'.repeat(64)));
  const snaps = await rt.syncSnapshotStore.list('evol', STEVE);
  assert.deepEqual(snaps.map((s) => s._id), [`evol:${STEVE}:0:shadow:e7575fc9:${AT}`]);
  assert.equal((await rt.syncSnapshotStore.list('evol', '11111111-2222-3333-4444-555555555555')).length, 0, 'a bad sha256 is dropped');

  const status = await rt.syncService.groupStatus('evol');
  assert.deepEqual(
    status.instances.map((i) => [i.serverId, i.instanceNumber, i.live, i.fp, i.fpMatch]),
    [
      ['e7575fc9', 1, true, FP, true],
      ['1ae705e3', 2, true, FP, true],
    ],
  );
  assert.ok(status.instances[0]!.features.includes('player_sync'));
  assert.equal(status.counts.online, 1);

  assert.deepEqual(await rt.syncService.shadowMove('evol', STEVE, 'e7575fc9', '1ae705e3'), { verdict: 'ok', reasons: [] });
  assert.deepEqual(
    (await rt.syncService.shadowMove('evol', STEVE, 'e7575fc9', 'a0000001')).reasons,
    [{ code: 'not_member', serverId: 'a0000001' }],
  );

  b.t.close();
  assert.equal(lm.liveInstance('1ae705e3'), null, 'a closed transport is not live');
  const closed = await rt.syncService.shadowMove('evol', STEVE, 'e7575fc9', '1ae705e3');
  assert.deepEqual(closed.reasons, [{ code: 'no_link', serverId: '1ae705e3' }]);

  lm.removeSession('evo1');
  lm.removeSession('evo2');
});

test('sync link: a re-sent reg_ack (a policy grant) reaches the sync sink, as a register does', async () => {
  const seen: string[] = [];
  lm.setSyncSink({
    onPresence: async () => undefined,
    onSyncSnap: async () => undefined,
    onLinkUp: async (identity) => {
      seen.push(identity.serverId ?? '');
    },
  });
  const a = transport();
  try {
    lm.registerSession('grant1', a.t, '10.0.0.6:1');
    await lm.dispatch('grant1', 'biforesting:register', register('e7575fc9', syncTail(FP)));
    assert.deepEqual(seen, ['e7575fc9']);
    const sends = a.state.sends;
    assert.equal(await lm.resendRegAck('e7575fc9'), true);
    assert.equal(a.state.sends, sends + 1, 'the reg_ack went out');
    assert.deepEqual(seen, ['e7575fc9', 'e7575fc9'], 'parked sync work runs again on a grant');
    assert.equal(await lm.resendRegAck('zzzzzzzz'), false);
    assert.equal(seen.length, 2);
  } finally {
    lm.removeSession('grant1');
    lm.setSyncSink(rt.syncService);
  }
});

test('sync link: a bad register tail still registers; mode off and unresolved sessions write nothing', async () => {
  const a = transport();
  lm.registerSession('bad1', a.t, '10.0.0.3:1');
  await lm.dispatch('bad1', 'biforesting:register', register('e7575fc9', '{"fp":'));
  assert.ok(a.state.sends >= 1, 'register answered');
  assert.equal(lm.liveInstance('e7575fc9')?.sync, null, 'no fingerprint from a bad tail');

  const u = '22222222-3333-4444-5555-666666666666';
  await rt.syncGroupsStore.upsert('evol', { mode: 'off' }, 'test');
  try {
    await lm.dispatch('bad1', 'biforesting:presence', encodeJsonPayload(JSON.stringify({ event: 'join', player: { uuid: u, name: 'Off' } })));
    await lm.dispatch('bad1', 'biforesting:syncsnap', syncsnap(u, Buffer.from([5])));
  } finally {
    await rt.syncGroupsStore.upsert('evol', { mode: 'shadow' }, 'test');
  }
  assert.equal(await rt.syncLedgerStore.get('evol', u), null);
  assert.equal((await rt.syncSnapshotStore.list('evol', u)).length, 0);

  const x = transport();
  lm.registerSession('stranger', x.t, '10.0.0.4:1');
  await lm.dispatch('stranger', 'biforesting:register', register('zzzzzzzz', syncTail(FP)));
  await lm.dispatch('stranger', 'biforesting:presence', encodeJsonPayload(JSON.stringify({ event: 'join', player: { uuid: u, name: 'X' } })));
  await lm.dispatch('stranger', 'biforesting:syncsnap', syncsnap(u, Buffer.from([6])));
  assert.equal(await rt.syncLedgerStore.get('evol', u), null);
  assert.equal((await rt.syncSnapshotStore.list('evol', u)).length, 0);

  lm.removeSession('bad1');
  lm.removeSession('stranger');
});
