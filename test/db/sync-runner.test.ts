import '../helpers/env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';

import { startTestMongo, type TestMongo } from '../helpers/mongo.ts';
import { eventBus } from '../../src/core/event-bus/index.ts';
import type { AppEventPayload } from '../../src/core/event-bus/events.ts';
import { Reader } from '../../src/plugins/biforesting-link/frame-codec.ts';
import { OpsStore } from '../../src/plugins/biforesting-link/ops-store.ts';
import { OpDispatcher } from '../../src/plugins/biforesting-link/op-dispatcher.ts';
import { setPolicy, setPolicyDbProvider, maskForFeatures } from '../../src/plugins/biforesting-link/policy-store.ts';
import { SyncGroupsStore } from '../../src/plugins/biforesting-link/sync-groups-store.ts';
import { SyncLedgerStore, ledgerId, type SyncPlayerDoc } from '../../src/plugins/biforesting-link/sync-ledger-store.ts';
import { SyncSnapshotStore } from '../../src/plugins/biforesting-link/sync-snapshot-store.ts';
import { SyncShadowStore } from '../../src/plugins/biforesting-link/sync-shadow-store.ts';
import { SyncMovesStore, type SyncMoveDoc } from '../../src/plugins/biforesting-link/sync-moves-store.ts';
import { SyncWorldDataStore } from '../../src/plugins/biforesting-link/sync-worlddata-store.ts';
import {
  SyncRunner,
  SyncConflictError,
  provablyUnrun,
  type SyncReseedResult,
  type SyncRunnerDeps,
  type SyncRunnerDirectory,
} from '../../src/plugins/biforesting-link/sync-runner.ts';
import { SyncService, type SyncInstanceLink, type SyncLiveHooks } from '../../src/plugins/biforesting-link/sync-service.ts';
import type { GroupMember } from '../../src/plugins/biforesting-link/server-resolver.ts';
import type { LinkIdentity, OpDoc, SyncStamp, SyncWorldDataEntry } from '../../src/plugins/biforesting-link/types.ts';

/**
 * Player sync S2/S3 runner (player-sync spec 6): the move state machine with a fake send port and
 * simulated op results, crash paths, the detector, disown reconcile, world-data locks, cooldown
 * and the long poll. The real ops store and dispatcher run over mem-mongo.
 */

let mongo: TestMongo;
let db: Db;
let store: OpsStore;
let dispatcher: OpDispatcher;
let groups: SyncGroupsStore;
let ledger: SyncLedgerStore;
let snapshots: SyncSnapshotStore;
let moves: SyncMovesStore;
let worldData: SyncWorldDataStore;
let service: SyncService;
let current: SyncRunner;

const FP = 'f'.repeat(64);
const A = 'aaaa0001';
const B = 'bbbb0002';
const C = 'cccc0003';
const BP = 'sophisticatedbackpacks';

/** serverId → group and instance number. */
const memberships = new Map<string, { group: string; n: number }>([
  [A, { group: 'evol', n: 1 }],
  [B, { group: 'evol', n: 2 }],
  [C, { group: 'evol', n: 3 }],
  ['dddd0001', { group: 'dgrp', n: 1 }],
  ['dddd0002', { group: 'dgrp', n: 2 }],
  ['eeee0001', { group: 'bgrp', n: 1 }],
  ['eeee0002', { group: 'bgrp', n: 2 }],
  ['mmmm0001', { group: 'mgrp', n: 1 }],
  ['mmmm0002', { group: 'mgrp', n: 2 }],
  ['rrrr0001', { group: 'rgrp', n: 1 }],
  ['rrrr0002', { group: 'rgrp', n: 2 }],
  ['rrrr0003', { group: 'rgrp', n: 3 }],
]);
const ik = (serverId: string): string => `ik-${serverId}`;
const GRANT = maskForFeatures(['play_transport', 'ops', 'player_sync']);

/** Live link facts by serverId. Every member is live with player_sync and one fingerprint. */
const links = new Map<string, SyncInstanceLink>();

const sent: Array<{ instanceKey: string; opId: string; type: string; params: Record<string, unknown>; blob: Buffer | null }> = [];
const liveKeys = new Set<string>();

let offset = 0;
const now = (): number => Date.now() + offset;

function decodeOp(payload: Buffer): { opId: string; type: string; params: Record<string, unknown>; blob: Buffer | null } {
  const r = new Reader(payload);
  const ver = r.varInt();
  const json = JSON.parse(r.utf()) as { opId: string; type: string; params: Record<string, unknown> };
  const blob = ver === 2 ? r.bytes(r.varInt()) : null;
  return { opId: json.opId, type: json.type, params: json.params, blob };
}

const directory: SyncRunnerDirectory = {
  groupOf: async (serverId) => memberships.get(serverId)?.group ?? null,
  groupMembers: async (group) =>
    [...memberships.entries()]
      .filter(([, m]) => m.group === group)
      .map(([serverId, m]): GroupMember => ({ serverId, instanceNumber: m.n, name: serverId })),
  instanceOf: async (serverId) => (memberships.has(serverId) ? { instanceKey: ik(serverId), tag: memberships.get(serverId)!.group } : null),
};

function mkRunner(holder: string): SyncRunner {
  return new SyncRunner({
    stores: { groups, ledger, snapshots, moves, worldData },
    ops: store,
    dispatch: dispatcher,
    directory,
    links: { instance: async (serverId) => links.get(serverId) ?? null },
    holder,
    now,
    schedule: () => undefined,
  });
}

before(async () => {
  mongo = await startTestMongo();
  db = mongo.client.db('ygg_sync_runner_test');
  setPolicyDbProvider(() => db);
  store = new OpsStore(() => db);
  dispatcher = new OpDispatcher(store, {
    sendDown: (instanceKey, _channel, payload) => {
      if (!liveKeys.has(instanceKey)) return false;
      sent.push({ instanceKey, ...decodeOp(payload) });
      return true;
    },
    liveInstanceKeys: () => [...liveKeys],
  });
  groups = new SyncGroupsStore(() => db, now);
  ledger = new SyncLedgerStore(() => db, now);
  snapshots = new SyncSnapshotStore(() => db, ledger);
  moves = new SyncMovesStore(() => db, now);
  worldData = new SyncWorldDataStore(() => db, now);
  for (const s of [groups, ledger, snapshots, moves, worldData]) await s.ensureIndexes();
  dispatcher.setSyncSnapshots(snapshots);
  dispatcher.setUpdateHook((op) => current.onOpUpdate(op));
  current = mkRunner('test-1');
  const hooks: SyncLiveHooks = {
    onPresence: (...args) => current.onPresence(...args),
    onReleaseSnapshot: (...args) => current.onReleaseSnapshot(...args),
    onMemberLinkUp: (...args) => current.onMemberLinkUp(...args),
  };
  service = new SyncService({ groups, ledger, snapshots, shadow: new SyncShadowStore(() => db) }, directory, { instance: async (s) => links.get(s) ?? null }, hooks);
  for (const serverId of memberships.keys()) {
    await setPolicy(ik(serverId), { enabledFeatures: GRANT }, 'test');
    links.set(serverId, { instanceKey: ik(serverId), grantedFeatures: GRANT, fp: FP });
    liveKeys.add(ik(serverId));
  }
  await groups.upsert('evol', { mode: 'live' }, 'test');
  await groups.upsert('mgrp', { mode: 'live' }, 'test');
  await groups.upsert('rgrp', { mode: 'live' }, 'test');
});
after(async () => mongo.stop());

// ── Helpers ──────────────────────────────────────────────────────────────────

let seq = 0;
const newUuid = (): string => `00000000-0000-4000-a000-${String(++seq).padStart(12, '0')}`;

function identity(serverId: string): LinkIdentity {
  const group = memberships.get(serverId)?.group ?? 'none';
  return { linkServerId: serverId, tag: group, instanceKey: ik(serverId), name: null, serverId, serverOid: null, resolved: true };
}

async function join(serverId: string, uuid: string, stamp?: SyncStamp): Promise<void> {
  await service.onPresence(identity(serverId), { event: 'join', player: { uuid, name: 'Steve', ...(stamp ? { sync: stamp } : {}) }, online: null });
  await current.idle();
}

async function quit(serverId: string, uuid: string): Promise<void> {
  await service.onPresence(identity(serverId), { event: 'quit', player: { uuid, name: 'Steve' }, online: null });
  await current.idle();
}

/** A ledger doc owned by `owner` at version `v`, made by a join with a matching stamp. */
async function seed(uuid: string, owner: string, v: number): Promise<void> {
  const group = memberships.get(owner)!.group;
  await join(owner, uuid, v > 0 ? { g: group, v } : undefined);
  const doc = await ledger.get(group, uuid);
  assert.equal(doc?.owner, owner);
  assert.equal(doc?.version, v);
}

async function opsOf(uuid: string, type?: string): Promise<OpDoc[]> {
  return db
    .collection<OpDoc>('biforesting_ops')
    .find({ 'target.uuid': uuid, ...(type ? { type } : {}) })
    .sort({ _id: 1 })
    .toArray();
}

async function lastOp(uuid: string, type: string): Promise<OpDoc> {
  const list = await opsOf(uuid, type);
  assert.ok(list.length > 0, `no ${type} op for ${uuid}`);
  return list[list.length - 1]!;
}

async function ack(op: OpDoc): Promise<void> {
  await dispatcher.onOpRes(op.instanceKey, { opId: op._id, phase: 'ack' });
  await current.idle();
}

async function answer(op: OpDoc, status: 'completed' | 'failed', result?: unknown, code?: string): Promise<void> {
  await dispatcher.onOpRes(op.instanceKey, { opId: op._id, phase: 'ack' });
  await dispatcher.onOpRes(op.instanceKey, {
    opId: op._id,
    phase: 'result',
    status,
    ...(result !== undefined ? { result } : {}),
    ...(code ? { code, error: `mod says ${code}` } : {}),
  });
  await current.idle();
}

async function moveOf(id: string): Promise<SyncMoveDoc> {
  const m = await moves.get(id);
  assert.ok(m, `move ${id}`);
  return m;
}

function groupOfServer(serverId: string): string {
  return memberships.get(serverId)!.group;
}

async function start(uuid: string, from = A, to = B): Promise<string> {
  const view = await current.startMove(groupOfServer(from), uuid, { from, to, actor: 'test' });
  return view.id;
}

/** The mod side of a release upload: a `release` syncsnap from `serverId`. Returns its sha256. */
async function upload(serverId: string, uuid: string, m: SyncMoveDoc, body: Buffer, wd: SyncWorldDataEntry[] = []): Promise<string> {
  const sha = createHash('sha256').update(body).digest('hex');
  await service.onSyncSnap(identity(serverId), {
    header: { kind: 'release', uuid, name: 'Steve', group: m.group, v: m.vTo, moveId: m._id, fp: FP, sha256: sha, gzLen: body.length, blocked: [], links: [], worldData: wd, playerData: [] },
    gz: body,
  });
  return sha;
}

/** Start a move and bring it to step release (prepare passed, quit seen). */
async function toRelease(uuid: string, from = A, to = B): Promise<string> {
  const id = await start(uuid, from, to);
  await answer(await lastOp(uuid, 'sync_prepare'), 'completed', { armed: true, online: true, links: [] });
  assert.equal((await moveOf(id)).step, 'wait_quit');
  await quit(from, uuid);
  assert.equal((await moveOf(id)).step, 'release');
  return id;
}

/** Bring a move to step apply: release uploaded and answered. */
async function toApply(uuid: string, wd: SyncWorldDataEntry[] = [], from = A, to = B): Promise<{ id: string; sha: string; body: Buffer }> {
  const id = await toRelease(uuid, from, to);
  const m = await moveOf(id);
  const body = Buffer.from(`gz-of-${uuid}`);
  const sha = await upload(from, uuid, m, body, wd);
  await answer(await lastOp(uuid, 'sync_release'), 'completed', { sha256: sha, gzLen: body.length, v: m.vTo, worldData: wd.map(({ h, key }) => ({ h, key })), playerData: ['puffish_skills'] });
  return { id, sha, body };
}

async function rejectsWith(p: Promise<unknown>, code: string): Promise<SyncConflictError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof SyncConflictError, `expected a SyncConflictError, got ${String(err)}`);
    assert.equal(err.code, code);
    assert.equal(err.statusCode, 409);
    return err;
  }
  assert.fail(`expected 409 ${code}`);
}

// ── Happy path ───────────────────────────────────────────────────────────────

test('move: A to B runs prepare, wait_quit, release, apply and commit', async () => {
  const u = newUuid();
  await seed(u, A, 3);
  const events: Array<AppEventPayload<'biforesting.sync.move'>> = [];
  const listener = (p: AppEventPayload<'biforesting.sync.move'>): void => {
    events.push(p);
  };
  eventBus.on('biforesting.sync.move', listener);
  try {
    const view = await current.startMove('evol', u, { from: A, to: B, actor: 'bifrost:switch', reason: 'player switch' });
    assert.equal(view.step, 'prepare');
    assert.equal(view.owner, A);
    assert.equal(view.version, 3);
    assert.equal(view.message, 'Getting your character ready to move to Instance 2.');
    const id = view.id;

    const locked = await ledger.get('evol', u);
    assert.equal(locked?.state, 'moving');
    assert.equal(locked?.move?.id, id);
    assert.equal(locked?.lease?.holder, 'test-1');

    const prep = await lastOp(u, 'sync_prepare');
    assert.equal(prep.instanceKey, ik(A));
    assert.deepEqual(prep.params, { group: 'evol', moveId: id, v: 4, to: B, toLabel: 'Instance 2' });
    assert.equal(prep.idempotencyKey, `sync:evol:${u}:${id}:prepare`);
    assert.equal(prep.execTimeoutMs, 120_000);
    assert.equal(prep.maxAttempts, 10);
    assert.equal(prep.expiresAt.getTime() - prep.createdAt.getTime(), 7 * 24 * 3600_000);
    assert.ok(sent.some((s) => s.opId === prep._id), 'the prepare went down the link');

    await answer(prep, 'completed', { armed: true, online: true, links: [] });
    assert.equal((await moveOf(id)).step, 'wait_quit');
    assert.equal((await ledger.get('evol', u))?.move?.step, 'wait_quit');

    await quit(A, u);
    assert.equal((await moveOf(id)).step, 'release');
    const rel = await lastOp(u, 'sync_release');
    assert.equal(rel.instanceKey, ik(A));
    assert.deepEqual(rel.params, { group: 'evol', moveId: id, v: 4, to: B, toLabel: 'Instance 2' });

    const body = Buffer.from('release-blob-gz');
    const sha = await upload(A, u, await moveOf(id), body);
    await answer(rel, 'completed', { sha256: sha, gzLen: body.length, v: 4, worldData: [], playerData: ['puffish_skills'] });
    const applying = await ledger.get('evol', u);
    assert.equal(applying?.state, 'applying');
    assert.equal(applying?.owner, null);
    assert.equal(applying?.version, 4);

    const apply = await lastOp(u, 'sync_apply');
    assert.equal(apply.instanceKey, ik(B));
    assert.equal(apply.params['snapshotId'], `evol:${u}:4:release:${A}:${id}:${sha.slice(0, 12)}`, 'the stored op names the snapshot');
    const wire = sent.find((s) => s.opId === apply._id);
    assert.ok(wire, 'the apply went down the link');
    assert.deepEqual(wire.params, { group: 'evol', moveId: id, v: 4, sha256: sha, fp: FP }, 'wire params per spec 3.5');
    assert.deepEqual(wire.blob, body, 'the release gz rides as the v2 blob');

    await answer(apply, 'completed', { applied: true, created: false, already: false, v: 4 });
    const owned = await ledger.get('evol', u);
    assert.equal(owned?.state, 'online');
    assert.equal(owned?.owner, B);
    assert.equal(owned?.version, 4);
    assert.equal(owned?.move, null);
    assert.equal(owned?.lease, null);
    assert.deepEqual(owned?.disowned, [A], 'the release left an away mark on the source');
    const committed = await moveOf(id);
    assert.equal(committed.outcome, 'committed');
    assert.equal(committed.step, 'commit', 'the ledger did not wait for the commit op');

    const commit = await lastOp(u, 'sync_commit');
    assert.equal(commit.instanceKey, ik(A));
    assert.deepEqual(commit.params, { group: 'evol', moveId: id, v: 4 });
    await answer(commit, 'completed', { removed: [] });
    assert.equal((await moveOf(id)).step, 'done');
    const done = await current.getMove('evol', u, id);
    assert.equal(done.message, 'Your character is now on Instance 2.');
    assert.equal(done.owner, B);

    const mine = events.filter((e) => e.moveId === id);
    assert.deepEqual(
      mine.map((e) => e.step),
      ['prepare', 'wait_quit', 'release', 'apply', 'commit', 'done'],
    );
    assert.equal(mine.find((e) => e.step === 'commit')?.outcome, 'committed');
    assert.equal('gz' in mine[0]!, false);
  } finally {
    eventBus.off('biforesting.sync.move', listener);
  }
});

test('move: a prepare that finds the player offline releases without a quit', async () => {
  const u = newUuid();
  await seed(u, A, 0);
  const id = await start(u);
  await answer(await lastOp(u, 'sync_prepare'), 'completed', { armed: true, online: false });
  const m = await moveOf(id);
  assert.equal(m.step, 'wait_quit');
  assert.equal(m.prepareOnline, false);
  await current.kick(id);
  assert.equal((await moveOf(id)).step, 'wait_quit', 'not before the release delay');
  offset += 3_001;
  await current.kick(id);
  assert.equal((await moveOf(id)).step, 'release');
  await current.cancelMove('evol', u, id, 'test');
});

// ── Abort branches ───────────────────────────────────────────────────────────

test('abort: prepare blocked lists the items, keeps online(A, n) and sends sync_abort', async () => {
  const u = newUuid();
  await seed(u, A, 2);
  const id = await start(u);
  const blocked = [{ where: 'Inventory', slot: '5', id: 'dankstorage:dank_3', reason: 'block' }];
  const prep = await lastOp(u, 'sync_prepare');
  await answer(prep, 'failed', { blocked }, 'blocked');
  assert.deepEqual((await store.get(prep._id))?.result?.data, { blocked }, 'a failed result keeps its body');

  const m = await moveOf(id);
  assert.equal(m.outcome, 'aborted');
  assert.equal(m.code, 'blocked');
  assert.deepEqual(m.blocked, blocked);
  const doc = await ledger.get('evol', u);
  assert.deepEqual([doc?.state, doc?.owner, doc?.version, doc?.move], ['online', A, 2, null]);
  const view = await current.getMove('evol', u, id);
  assert.equal(view.message, 'These items cannot travel: dankstorage:dank_3. Leave them on Instance 1, then try again.');
  assert.deepEqual(view.blocked, blocked);

  const abort = await lastOp(u, 'sync_abort');
  assert.equal(abort.instanceKey, ik(A));
  assert.deepEqual(abort.params, { group: 'evol', moveId: id });
  await answer(abort, 'completed', { released: [] });
  assert.equal((await moveOf(id)).step, 'done');

  // An aborted move starts no cooldown.
  const again = await start(u);
  assert.equal((await moveOf(again)).step, 'prepare');
  await current.cancelMove('evol', u, again, 'test');
});

test('abort: prepare with no result in 10 s times out; sync_abort waits for the prepare op to end', async () => {
  const u = newUuid();
  await seed(u, A, 1);
  const id = await start(u);
  const prep = await lastOp(u, 'sync_prepare');
  await ack(prep);
  offset += 10_001;
  await current.sweep();
  await current.idle();
  const m = await moveOf(id);
  assert.equal(m.outcome, 'aborted');
  assert.equal(m.code, 'timeout');
  assert.equal((await ledger.get('evol', u))?.state, 'online');
  assert.equal((await opsOf(u, 'sync_abort')).length, 0, 'the prepare still runs on A');

  await answer(prep, 'failed');
  const abort = await lastOp(u, 'sync_abort');
  assert.equal(abort.instanceKey, ik(A));
  await answer(abort, 'completed', {});
  assert.equal((await moveOf(id)).step, 'done');
});

test('abort: a player still online on A after 60 s aborts with player_online', async () => {
  const u = newUuid();
  await seed(u, A, 1);
  const id = await start(u);
  await answer(await lastOp(u, 'sync_prepare'), 'completed', { armed: true, online: true });
  offset += 30_000;
  await current.sweep();
  await current.idle();
  assert.equal((await moveOf(id)).step, 'wait_quit');
  offset += 30_001;
  await current.sweep();
  await current.idle();
  const m = await moveOf(id);
  assert.equal(m.code, 'player_online');
  const doc = await ledger.get('evol', u);
  assert.deepEqual([doc?.state, doc?.owner, doc?.version], ['online', A, 1]);
  assert.equal((await current.getMove('evol', u, id)).message, 'You were still online on Instance 1, so the move stopped. Try again.');
  assert.equal((await lastOp(u, 'sync_abort')).instanceKey, ik(A));
});

test('abort: release blocked keeps online(A, n)', async () => {
  const u = newUuid();
  await seed(u, A, 6);
  const id = await toRelease(u);
  const blocked = [{ where: 'curios', slot: 'back', id: 'computercraft:pocket_computer', reason: 'block' }];
  await answer(await lastOp(u, 'sync_release'), 'failed', { blocked }, 'blocked');
  const m = await moveOf(id);
  assert.equal(m.code, 'blocked');
  assert.deepEqual(m.blocked, blocked);
  const doc = await ledger.get('evol', u);
  assert.deepEqual([doc?.state, doc?.owner, doc?.version], ['online', A, 6]);
  assert.equal((await lastOp(u, 'sync_abort')).instanceKey, ik(A));
});

test('abort: a release result without a stored snapshot retries with a new key, then aborts at online(A, n+1)', async () => {
  const u = newUuid();
  await seed(u, A, 2);
  const id = await toRelease(u);
  const missing = { sha256: 'e'.repeat(64), gzLen: 10, v: 3, worldData: [], playerData: [] };
  await answer(await lastOp(u, 'sync_release'), 'completed', missing);
  const second = await lastOp(u, 'sync_release');
  assert.equal(second.idempotencyKey, `sync:evol:${u}:${id}:release:1`);
  assert.equal((await moveOf(id)).step, 'release');
  await answer(second, 'completed', missing);
  const third = await lastOp(u, 'sync_release');
  assert.equal(third.idempotencyKey, `sync:evol:${u}:${id}:release:2`);
  await answer(third, 'completed', missing);
  const m = await moveOf(id);
  assert.equal(m.outcome, 'aborted');
  assert.equal(m.code, 'error');
  assert.equal((await opsOf(u, 'sync_release')).length, 3, 'the retries are bounded');
  const doc = await ledger.get('evol', u);
  assert.deepEqual([doc?.state, doc?.owner, doc?.version], ['online', A, 3], 'the source stamp reads n+1');
  assert.equal((await lastOp(u, 'sync_abort')).instanceKey, ik(A));
});

test('abort: apply fingerprint_mismatch gives online(A, n+1), world data back to A, sync_abort to A', async () => {
  const u = newUuid();
  await seed(u, A, 4);
  const key = `bp-${u}`;
  const { id } = await toApply(u, [{ h: BP, key, rawLen: 10 }]);
  assert.deepEqual(
    (({ state, owner, moveId }) => ({ state, owner, moveId }))((await worldData.get('evol', BP, key))!),
    { state: 'in_transit', owner: A, moveId: id },
  );
  await answer(await lastOp(u, 'sync_apply'), 'failed', undefined, 'fingerprint_mismatch');
  const m = await moveOf(id);
  assert.equal(m.code, 'fingerprint_mismatch');
  const doc = await ledger.get('evol', u);
  assert.deepEqual([doc?.state, doc?.owner, doc?.version, doc?.move], ['online', A, 5, null]);
  const lock = await worldData.get('evol', BP, key);
  assert.deepEqual([lock?.state, lock?.owner, lock?.moveId], ['owned', A, null]);
  assert.equal((await current.getMove('evol', u, id)).message, 'The instances run different pack versions right now. Try again after the update.');
  const abort = await lastOp(u, 'sync_abort');
  assert.equal(abort.instanceKey, ik(A));
  await answer(abort, 'completed', { released: [{ h: BP, key }] });
  assert.equal((await moveOf(id)).step, 'done');
});

// ── Crash paths ──────────────────────────────────────────────────────────────

test('crash: A down at release; the move waits and resumes on link-up', async () => {
  const u = newUuid();
  await seed(u, A, 0);
  const id = await start(u);
  await answer(await lastOp(u, 'sync_prepare'), 'completed', { armed: true, online: true });
  liveKeys.delete(ik(A));
  try {
    await quit(A, u);
    const rel = await lastOp(u, 'sync_release');
    assert.equal(rel.state, 'pending', 'A is down, the release waits durably');
    await current.sweep();
    await current.idle();
    assert.equal((await moveOf(id)).step, 'release');
    assert.equal((await ledger.get('evol', u))?.state, 'moving');
  } finally {
    liveKeys.add(ik(A));
  }
  await dispatcher.onLinkUp(ik(A));
  await current.idle();
  const rel = await lastOp(u, 'sync_release');
  assert.equal(rel.state, 'dispatched');
  const body = Buffer.from('late');
  const sha = await upload(A, u, await moveOf(id), body);
  await answer(rel, 'completed', { sha256: sha, gzLen: body.length, v: 1 });
  assert.equal((await moveOf(id)).step, 'apply');
  await answer(await lastOp(u, 'sync_apply'), 'completed', { applied: true, v: 1 });
  assert.equal((await ledger.get('evol', u))?.owner, B);
});

test('crash: B down at apply; a cancel of an apply that never left aborts to online(A, n+1)', async () => {
  const u = newUuid();
  await seed(u, A, 0);
  liveKeys.delete(ik(B));
  let id: string;
  try {
    ({ id } = await toApply(u));
    const apply = await lastOp(u, 'sync_apply');
    assert.equal(apply.state, 'pending');
    assert.equal(provablyUnrun(apply), true, 'the link write failed, so nothing reached B');
    await current.cancelMove('evol', u, id, 'staff');
  } finally {
    liveKeys.add(ik(B));
  }
  const m = await moveOf(id);
  assert.equal(m.outcome, 'cancelled');
  assert.equal(m.code, 'cancelled');
  assert.equal((await lastOp(u, 'sync_apply')).state, 'cancelled');
  const doc = await ledger.get('evol', u);
  assert.deepEqual([doc?.state, doc?.owner, doc?.version], ['online', A, 1]);
  assert.equal((await lastOp(u, 'sync_abort')).instanceKey, ik(A));
  assert.equal((await current.getMove('evol', u, id)).message, 'The move was cancelled. Your character stays on Instance 1.');
});

test('crash: B took the apply; cancel probes B, and a stamp there commits instead', async () => {
  const u = newUuid();
  await seed(u, A, 7);
  const { id } = await toApply(u);
  await ack(await lastOp(u, 'sync_apply'));
  await current.cancelMove('evol', u, id, 'staff');
  const probe = await lastOp(u, 'sync_probe');
  assert.equal(probe.instanceKey, ik(B));
  assert.deepEqual(probe.params, { group: 'evol' });
  assert.equal((await moveOf(id)).step, 'apply');
  await answer(probe, 'completed', { online: false, datExists: true, stamp: { g: 'evol', v: 8, m: id }, fp: FP, locks: [] });
  const m = await moveOf(id);
  assert.equal(m.outcome, 'committed');
  const doc = await ledger.get('evol', u);
  assert.deepEqual([doc?.state, doc?.owner, doc?.version], ['online', B, 8]);
  await answer(await lastOp(u, 'sync_apply'), 'completed', { applied: true, already: true, v: 8 });
  assert.equal((await lastOp(u, 'sync_commit')).instanceKey, ik(A));
});

test('crash: B took the apply; cancel probes B, no stamp (key left out), then the apply fails and the move aborts', async () => {
  const u = newUuid();
  await seed(u, A, 1);
  const { id } = await toApply(u);
  const apply = await lastOp(u, 'sync_apply');
  await ack(apply);
  await current.cancelMove('evol', u, id, 'staff');
  // The mod leaves out null keys: no stamp, no moving, no away.
  await answer(await lastOp(u, 'sync_probe'), 'completed', { online: false, datExists: false, fp: FP, locks: [] });
  assert.equal((await moveOf(id)).step, 'apply', 'the apply still runs on B; its result decides');
  await answer(apply, 'failed', undefined, 'not_applied');
  const m = await moveOf(id);
  assert.equal(m.outcome, 'cancelled');
  const doc = await ledger.get('evol', u);
  assert.deepEqual([doc?.state, doc?.owner, doc?.version], ['online', A, 2]);
});

test('crash: an apply with an unknown outcome is probed; no stamp means one retry, then stuck', async () => {
  const u = newUuid();
  await seed(u, A, 0);
  const { id } = await toApply(u);
  await answer(await lastOp(u, 'sync_apply'), 'failed', undefined, 'handler_failed');
  await answer(await lastOp(u, 'sync_probe'), 'completed', { online: false, datExists: true, fp: FP });
  const retry = await lastOp(u, 'sync_apply');
  assert.equal(retry.idempotencyKey, `sync:evol:${u}:${id}:apply:1`);
  await answer(retry, 'failed', undefined, 'handler_failed');
  await answer(await lastOp(u, 'sync_probe'), 'completed', { online: false, datExists: true, stamp: { g: 'evol', v: 0 } });
  const m = await moveOf(id);
  assert.equal(m.outcome, 'stuck');
  assert.equal(m.step, 'done');
  assert.equal((await ledger.get('evol', u))?.state, 'stuck');
  assert.equal((await current.getMove('evol', u, id)).message, 'Your character needs staff help to move. Open a ticket.');
  await rejectsWith(start(u), 'moving');
});

test('crash: after a handler_failed apply, a later changed-nothing answer goes stuck and never aborts', async () => {
  const u = newUuid();
  await seed(u, A, 0);
  const { id } = await toApply(u);
  await answer(await lastOp(u, 'sync_apply'), 'failed', undefined, 'handler_failed');
  await answer(await lastOp(u, 'sync_probe'), 'completed', { online: false, datExists: true, fp: FP });
  assert.equal((await moveOf(id)).applyUncertain, true);
  const retry = await lastOp(u, 'sync_apply');
  assert.equal(retry.idempotencyKey, `sync:evol:${u}:${id}:apply:1`);
  await answer(retry, 'failed', undefined, 'stale_version');
  const m = await moveOf(id);
  assert.deepEqual([m.outcome, m.step, m.error?.code], ['stuck', 'done', 'stuck']);
  const doc = await ledger.get('evol', u);
  assert.deepEqual([doc?.state, doc?.owner], ['stuck', null], 'B may hold imported handler data: no way back to A');
  assert.equal((await opsOf(u, 'sync_abort')).length, 0);
});

/**
 * A move at step apply after one apply with an unknown outcome and a probe without a stamp. B is
 * down, so the retry stays pending. A staff cancel then arrives.
 */
async function cancelAfterUncertainApply(u: string): Promise<{ id: string; firstProbe: OpDoc; retry: OpDoc }> {
  await seed(u, A, 0);
  const { id } = await toApply(u);
  await answer(await lastOp(u, 'sync_apply'), 'failed', undefined, 'handler_failed');
  const firstProbe = await lastOp(u, 'sync_probe');
  liveKeys.delete(ik(B));
  try {
    await answer(firstProbe, 'completed', { online: false, datExists: true, fp: FP });
    const retry = await lastOp(u, 'sync_apply');
    assert.equal(retry.idempotencyKey, `sync:evol:${u}:${id}:apply:1`);
    assert.equal(retry.state, 'pending');
    assert.equal((await moveOf(id)).applyUncertain, true);
    await current.cancelMove('evol', u, id, 'staff');
    const m = await moveOf(id);
    assert.deepEqual([m.outcome, m.step], [null, 'apply'], 'the cancel waits for a probe of B');
    assert.equal((await store.get(retry._id))?.state, 'cancelled', 'the retry never leaves Yggdrasil');
    const probe = await lastOp(u, 'sync_probe');
    assert.notEqual(probe._id, firstProbe._id, 'a fresh probe, sent after the cancel');
    assert.equal(probe.instanceKey, ik(B));
    return { id, firstProbe, retry };
  } finally {
    liveKeys.add(ik(B));
  }
}

test('crash: a staff cancel after an apply with an unknown outcome probes B first; a stamp of the move there commits', async () => {
  const u = newUuid();
  const { id } = await cancelAfterUncertainApply(u);
  await dispatcher.onLinkUp(ik(B));
  await current.idle();
  // The first apply landed after all: B holds the character.
  await answer(await lastOp(u, 'sync_probe'), 'completed', { online: false, datExists: true, stamp: { g: 'evol', v: 1, m: id }, fp: FP });
  const m = await moveOf(id);
  assert.deepEqual([m.outcome, m.step, m.needsReapply], ['committed', 'commit', true]);
  const doc = await ledger.get('evol', u);
  assert.deepEqual([doc?.state, doc?.owner, doc?.version], ['online', B, 1], 'the ledger follows the character to B');
  assert.equal((await opsOf(u, 'sync_abort')).length, 0);
  const reapply = await lastOp(u, 'sync_apply');
  assert.equal(reapply.idempotencyKey, `sync:evol:${u}:${id}:reapply`);
  await answer(reapply, 'completed', { applied: true, created: false, already: true, v: 1 });
  await answer(await lastOp(u, 'sync_commit'), 'completed', { removed: [] });
  assert.equal((await moveOf(id)).step, 'done');
});

test('crash: a staff cancel after an apply with an unknown outcome aborts once B shows no stamp and no apply can run', async () => {
  const u = newUuid();
  const { id } = await cancelAfterUncertainApply(u);
  await dispatcher.onLinkUp(ik(B));
  await current.idle();
  await answer(await lastOp(u, 'sync_probe'), 'completed', { online: false, datExists: true, fp: FP });
  const m = await moveOf(id);
  assert.deepEqual([m.outcome, m.code], ['cancelled', 'cancelled']);
  assert.match(m.error?.message ?? '', /the probe found no stamp, and no apply op can still run/);
  const doc = await ledger.get('evol', u);
  assert.deepEqual([doc?.state, doc?.owner, doc?.version], ['online', A, 1]);
  assert.equal((await lastOp(u, 'sync_abort')).instanceKey, ik(A));

  // An apply that already runs on B is waited for: its result decides, then a new probe.
  const w = newUuid();
  await seed(w, A, 0);
  const { id: wid } = await toApply(w);
  await answer(await lastOp(w, 'sync_apply'), 'failed', undefined, 'handler_failed');
  await answer(await lastOp(w, 'sync_probe'), 'completed', { online: false, datExists: true, fp: FP });
  const running = await lastOp(w, 'sync_apply');
  await ack(running);
  await current.cancelMove('evol', w, wid, 'staff');
  await answer(await lastOp(w, 'sync_probe'), 'completed', { online: false, datExists: true, fp: FP });
  assert.deepEqual([(await moveOf(wid)).outcome, (await store.get(running._id))?.state], [null, 'acked'], 'the running apply decides');
  await answer(running, 'completed', { applied: true, created: false, already: false, v: 1 });
  assert.equal((await moveOf(wid)).outcome, 'committed');
  assert.equal((await ledger.get('evol', w))?.owner, B);
});

test('crash: an apply that only a probe proves is applied once more at commit; sync_commit waits for it', async () => {
  const u = newUuid();
  await seed(u, A, 0);
  const { id } = await toApply(u);
  const apply = await lastOp(u, 'sync_apply');
  // B wrote the .dat, then crashed before it saved its sync state: no result ever comes, and
  // the dispatcher sweep fails the acked op after its exec timeout.
  await ack(apply);
  await store.markFailed(apply._id, 'no result within 120000ms of ack');
  await current.kick(id);
  await answer(await lastOp(u, 'sync_probe'), 'completed', { online: false, datExists: true, stamp: { g: 'evol', v: 1, m: id }, away: { v: 0, m: 'disown', to: A }, fp: FP });
  const m = await moveOf(id);
  assert.deepEqual([m.outcome, m.step, m.needsReapply], ['committed', 'commit', true]);
  assert.match(m.steps.find((s) => s.status === 'completed' && s.step === 'apply')?.detail ?? '', /away of disown is still set/);
  const doc = await ledger.get('evol', u);
  assert.deepEqual([doc?.state, doc?.owner, doc?.version], ['online', B, 1], 'the ledger does not wait for the re-apply');

  const reapply = await lastOp(u, 'sync_apply');
  assert.notEqual(reapply._id, apply._id);
  assert.equal(reapply.instanceKey, ik(B));
  assert.equal(reapply.idempotencyKey, `sync:evol:${u}:${id}:reapply`);
  assert.deepEqual(reapply.params, apply.params, 'the same params, so the mod takes its already path');
  assert.equal((await opsOf(u, 'sync_commit')).length, 0, 'the commit to A waits for the re-apply');
  await answer(reapply, 'completed', { applied: true, created: false, already: true, v: 1 });
  assert.equal((await moveOf(id)).needsReapply, false);
  await answer(await lastOp(u, 'sync_commit'), 'completed', { removed: [] });
  assert.equal((await moveOf(id)).step, 'done');

  // A re-apply that keeps failing gives up loudly, and the commit to A still goes out.
  const w = newUuid();
  await seed(w, A, 0);
  const { id: wid } = await toApply(w);
  await answer(await lastOp(w, 'sync_apply'), 'failed', undefined, 'handler_failed');
  await answer(await lastOp(w, 'sync_probe'), 'completed', { online: false, datExists: true, stamp: { g: 'evol', v: 1, m: wid }, fp: FP });
  for (let i = 0; i < 5; i++) await answer(await lastOp(w, 'sync_apply'), 'failed', undefined, 'bad_blob');
  const gaveUp = await moveOf(wid);
  assert.deepEqual([gaveUp.needsReapply, gaveUp.error?.code, gaveUp.attempts.reapply], [false, 'reapply_failed', 5]);
  assert.equal((await lastOp(w, 'sync_commit')).instanceKey, ik(A));
});

test('crash: Yggdrasil restart mid-move; the lease lapses and the new process resumes on the sweep', async () => {
  const u = newUuid();
  await seed(u, A, 0);
  const id = await start(u);
  await answer(await lastOp(u, 'sync_prepare'), 'completed', { armed: true, online: true });
  const first = current;
  current = mkRunner('test-2');
  try {
    await quit(A, u);
    await current.sweep();
    await current.idle();
    assert.equal((await moveOf(id)).step, 'wait_quit', 'the old lease is still live');
    assert.equal((await ledger.get('evol', u))?.lease?.holder, 'test-1');
    offset += 30_001;
    await current.sweep();
    await current.idle();
    assert.equal((await moveOf(id)).step, 'release');
    assert.equal((await ledger.get('evol', u))?.lease?.holder, 'test-2');
    assert.equal((await opsOf(u, 'sync_release')).length, 1);
  } finally {
    await current.cancelMove('evol', u, id, 'test');
    current = first;
  }
});

test('crash: a ledger lock whose move doc never got written is put back by the sweep', async () => {
  const u = newUuid();
  await seed(u, A, 3);
  await ledger.casUpdate(
    { _id: ledgerId('evol', u) },
    { $set: { state: 'moving', move: { id: 'GHOST', from: A, to: B, step: 'prepare', startedAt: new Date(now()), updatedAt: new Date(now()) }, lease: { holder: 'dead', until: new Date(now() - 1) } } },
  );
  await current.sweep();
  const doc = await ledger.get('evol', u);
  assert.deepEqual([doc?.state, doc?.owner, doc?.version, doc?.move], ['online', A, 3, null]);
});

// ── Concurrency and replay ───────────────────────────────────────────────────

test('race: two moves at once for one player, exactly one wins', async () => {
  const u = newUuid();
  await seed(u, A, 0);
  const results = await Promise.allSettled([start(u, A, B), start(u, A, C)]);
  const won = results.filter((r) => r.status === 'fulfilled');
  const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  assert.ok(lost[0]!.reason instanceof SyncConflictError);
  assert.equal((lost[0]!.reason as SyncConflictError).code, 'moving');
  assert.equal(await db.collection('biforesting_sync_moves').countDocuments({ uuid: u }), 1, 'the loser left no move doc');
  assert.equal((await opsOf(u, 'sync_prepare')).length, 1);
  await current.cancelMove('evol', u, (won[0] as PromiseFulfilledResult<string>).value, 'test');
});

test('replay: drives and keys never make a second op; a duplicate syncsnap keeps the first doc', async () => {
  const u = newUuid();
  await seed(u, A, 0);
  const id = await start(u);
  await current.kick(id);
  await current.sweep();
  await current.idle();
  const prepares = await opsOf(u, 'sync_prepare');
  assert.equal(prepares.length, 1);
  const again = await store.create({ instanceKey: ik(A), serverTag: 'evol', type: 'sync_prepare', params: {}, idempotencyKey: prepares[0]!.idempotencyKey!, createdBy: 'test' });
  assert.equal(again.replayed, true);
  assert.equal(again.op._id, prepares[0]!._id);

  await answer(prepares[0]!, 'completed', { armed: true, online: true });
  await quit(A, u);
  const m = await moveOf(id);
  const first = Buffer.from('first-upload');
  const sha = await upload(A, u, m, first);
  await upload(A, u, m, first);
  const docs = await snapshots.list('evol', u, 'release');
  assert.deepEqual(docs.map((s) => s._id), [`evol:${u}:1:release:${A}:${id}:${sha.slice(0, 12)}`], 'the replay kept one doc');
  await answer(await lastOp(u, 'sync_release'), 'completed', { sha256: sha, gzLen: first.length, v: 1 });
  assert.equal((await moveOf(id)).step, 'apply');
  await current.cancelMove('evol', u, id, 'test');
});

test('receipt: a retried release that builds another blob commits on its own sha256', async () => {
  const u = newUuid();
  await seed(u, A, 0);
  const id = await toRelease(u);
  const m = await moveOf(id);
  const sha1 = await upload(A, u, m, Buffer.from('first-build'));
  await answer(await lastOp(u, 'sync_release'), 'failed', undefined, 'handler_failed');
  await answer(await lastOp(u, 'sync_probe'), 'completed', { online: false, datExists: true, stamp: { g: 'evol', v: 1, m: id }, fp: FP });
  const second = await lastOp(u, 'sync_release');
  assert.equal(second.idempotencyKey, `sync:evol:${u}:${id}:release:1`);
  const body2 = Buffer.from('second-build');
  const sha2 = await upload(A, u, m, body2);
  await answer(second, 'completed', { sha256: sha2, gzLen: body2.length, v: 1 });
  const after = await moveOf(id);
  assert.equal(after.step, 'apply', 'the receipt of the second build passed');
  assert.equal(after.snapshotId, `evol:${u}:1:release:${A}:${id}:${sha2.slice(0, 12)}`);
  assert.ok(await snapshots.getMeta(`evol:${u}:1:release:${A}:${id}:${sha1.slice(0, 12)}`), 'the first build keeps its own doc');
  const apply = await lastOp(u, 'sync_apply');
  assert.deepEqual(sent.find((s) => s.opId === apply._id)?.blob, body2);
  await answer(apply, 'completed', { applied: true, v: 1 });
  assert.equal((await ledger.get('evol', u))?.owner, B);
});

test('receipt: a later move to the same version after an abort gets its own snapshot and goes on', async () => {
  const u = newUuid();
  await seed(u, A, 0);
  const first = await toRelease(u);
  await upload(A, u, await moveOf(first), Buffer.from('aborted-build'));
  await answer(await lastOp(u, 'sync_release'), 'failed', undefined, 'too_large');
  assert.equal((await moveOf(first)).outcome, 'aborted');
  assert.equal((await ledger.get('evol', u))?.version, 0, 'the release changed nothing');
  await answer(await lastOp(u, 'sync_abort'), 'completed', {});

  const second = await toRelease(u);
  const m = await moveOf(second);
  assert.equal(m.vTo, 1, 'the same version as the aborted move');
  const body = Buffer.from('second-move');
  const sha = await upload(A, u, m, body);
  await answer(await lastOp(u, 'sync_release'), 'completed', { sha256: sha, gzLen: body.length, v: 1 });
  assert.equal((await moveOf(second)).step, 'apply');
  assert.equal((await snapshots.list('evol', u, 'release')).length, 2);
  await current.cancelMove('evol', u, second, 'test');
});

test('receipt: a release upload from a non-owner is stored but never advances the ledger', async () => {
  const u = newUuid();
  await seed(u, A, 0);
  const id = await toRelease(u);
  const m = await moveOf(id);
  const sha = await upload(C, u, m, Buffer.from('from-the-wrong-server'));
  assert.ok(await snapshots.getMeta(`evol:${u}:1:release:${C}:${id}:${sha.slice(0, 12)}`), 'stored under the sender');
  assert.equal((await moveOf(id)).step, 'release');
  await answer(await lastOp(u, 'sync_release'), 'completed', { sha256: sha, gzLen: 21, v: 1 });
  const after = await moveOf(id);
  assert.equal(after.step, 'release', 'no receipt from A, so a retry instead of apply');
  assert.equal((await lastOp(u, 'sync_release')).idempotencyKey, `sync:evol:${u}:${id}:release:1`);
  const doc = await ledger.get('evol', u);
  assert.deepEqual([doc?.state, doc?.owner, doc?.version], ['moving', A, 0]);
  await current.cancelMove('evol', u, id, 'test');
});

// ── Detector ─────────────────────────────────────────────────────────────────

test('detector: the owner joins with a matching stamp, nothing happens', async () => {
  const u = newUuid();
  await seed(u, A, 2);
  await join(A, u, { g: 'evol', v: 2 });
  assert.equal((await opsOf(u, 'sync_kick')).length, 0);
});

test('detector: a non-owner join gets sync_kick and a one-entry sync_disown; the ledger stays', async () => {
  const u = newUuid();
  await seed(u, A, 2);
  await join(B, u, { g: 'evol', v: 2 });
  const kick = await lastOp(u, 'sync_kick');
  assert.equal(kick.instanceKey, ik(B));
  assert.deepEqual(kick.params, { group: 'evol', message: 'This character is on Instance 1. Join again to go there.', to: A, toLabel: 'Instance 1' });
  const disown = await db.collection<OpDoc>('biforesting_ops').findOne({ type: 'sync_disown', 'params.entries.u': u });
  assert.ok(disown);
  assert.equal(disown.instanceKey, ik(B));
  assert.equal(disown.target, null);
  assert.ok(disown.idempotencyKey?.startsWith(`sync:evol:disown:${B}:`));
  assert.deepEqual(disown.params, { group: 'evol', entries: [{ u, v: 2, to: A, toLabel: 'Instance 1' }] });
  const doc = await ledger.get('evol', u);
  assert.deepEqual([doc?.state, doc?.owner, doc?.version], ['online', A, 2]);

  await answer(disown, 'completed', { marked: 1, skipped: 0 });
  assert.deepEqual((await ledger.get('evol', u))?.disowned, [B]);
});

test('detector: a stale stamp on the owner is kicked; a stamp of another group counts as absent', async () => {
  const u = newUuid();
  await seed(u, A, 5);
  await join(A, u, { g: 'evol', v: 4 });
  assert.equal((await lastOp(u, 'sync_kick')).instanceKey, ik(A));

  const v = newUuid();
  await join(A, v, { g: 'other', v: 9 });
  const doc = await ledger.get('evol', v);
  assert.equal(doc?.version, 0, 'the foreign stamp did not set the version');
  assert.equal(doc?.lastSeen?.stamp, null);
  assert.equal((await opsOf(v, 'sync_kick')).length, 0);
  await join(A, v, { g: 'other', v: 9 });
  assert.equal((await opsOf(v, 'sync_kick')).length, 0, 'the owner with a foreign stamp is fine');
});

test('detector: a join on the target of a move whose apply is done is never kicked', async () => {
  const u = newUuid();
  await seed(u, A, 0);
  const { id } = await toApply(u);
  const apply = await lastOp(u, 'sync_apply');
  await ack(apply);
  await join(B, u);
  assert.equal((await opsOf(u, 'sync_kick')).length, 1, 'no proof of the apply yet');
  await join(B, u, { g: 'evol', v: 1, m: id });
  assert.equal((await opsOf(u, 'sync_kick')).length, 1, 'the stamp of this move proves the apply');
  await store.markCompleted(apply._id, { ok: true, data: { applied: true } });
  await join(B, u);
  assert.equal((await opsOf(u, 'sync_kick')).length, 1, 'the completed apply op proves it too');
  await current.kick(id);
  assert.equal((await ledger.get('evol', u))?.owner, B);
});

test('detector: a join on the target of an open move gets a kick and never a disown', async () => {
  const u = newUuid();
  await seed(u, A, 3);
  const disownsToB = (): Promise<number> => db.collection('biforesting_ops').countDocuments({ type: 'sync_disown', instanceKey: ik(B), 'params.entries.u': u });
  const id = await start(u);
  await answer(await lastOp(u, 'sync_prepare'), 'completed', { armed: true, online: true });
  await join(B, u);
  assert.equal((await lastOp(u, 'sync_kick')).instanceKey, ik(B), 'moving: kicked');
  assert.equal(await disownsToB(), 0, 'moving: no disown to the target');

  await quit(A, u);
  const m = await moveOf(id);
  const body = Buffer.from('to-b');
  const sha = await upload(A, u, m, body);
  await answer(await lastOp(u, 'sync_release'), 'completed', { sha256: sha, gzLen: body.length, v: 4 });
  await ack(await lastOp(u, 'sync_apply'));
  assert.equal((await ledger.get('evol', u))?.state, 'applying');
  await join(B, u);
  assert.equal((await opsOf(u, 'sync_kick')).filter((k) => k.instanceKey === ik(B)).length, 2, 'applying: kicked');
  assert.equal(await disownsToB(), 0, 'applying: no disown to the target, so a late one cannot mark the new owner away');
  await join(C, u);
  assert.equal(await db.collection('biforesting_ops').countDocuments({ type: 'sync_disown', instanceKey: ik(C), 'params.entries.u': u }), 1, 'any other member still gets one');

  await answer(await lastOp(u, 'sync_apply'), 'completed', { applied: true, v: 4 });
  assert.equal((await ledger.get('evol', u))?.owner, B);
});

// ── Disowns ──────────────────────────────────────────────────────────────────

test('disown: mode to live queues batches per member; completion fills disowned; register reconciles again', async () => {
  const D1 = 'dddd0001';
  const D2 = 'dddd0002';
  await groups.upsert('dgrp', { mode: 'shadow' }, 'test');
  const onD1 = [newUuid(), newUuid(), newUuid()];
  const onD2 = newUuid();
  for (const u of onD1) await join(D1, u);
  await join(D2, onD2);
  assert.equal(await db.collection('biforesting_ops').countDocuments({ type: 'sync_disown', instanceKey: { $in: [ik(D1), ik(D2)] } }), 0, 'shadow mode sends nothing');

  const before = await groups.get('dgrp');
  const after = await groups.upsert('dgrp', { mode: 'live' }, 'test');
  await current.onGroupUpdated('dgrp', before, after);
  await current.idle();
  const toD2 = await db.collection<OpDoc>('biforesting_ops').find({ type: 'sync_disown', instanceKey: ik(D2) }).toArray();
  const toD1 = await db.collection<OpDoc>('biforesting_ops').find({ type: 'sync_disown', instanceKey: ik(D1) }).toArray();
  assert.equal(toD2.length, 1);
  assert.deepEqual(
    (toD2[0]!.params['entries'] as Array<{ u: string; to: string; toLabel: string }>).map((e) => [e.u, e.to, e.toLabel]),
    onD1.map((u) => [u, D1, 'Instance 1']),
  );
  assert.equal(toD1.length, 1);
  assert.deepEqual((toD1[0]!.params['entries'] as Array<{ u: string }>).map((e) => e.u), [onD2]);

  await answer(toD2[0]!, 'completed', { marked: 3, skipped: 0 });
  for (const u of onD1) assert.deepEqual((await ledger.get('dgrp', u))?.disowned, [D2]);

  await service.onLinkUp(identity(D2));
  await service.onLinkUp(identity(D1));
  await current.idle();
  assert.equal(await db.collection('biforesting_ops').countDocuments({ type: 'sync_disown', instanceKey: ik(D2) }), 1, 'all disowned already');
  assert.equal(await db.collection('biforesting_ops').countDocuments({ type: 'sync_disown', instanceKey: ik(D1) }), 1, 'the open op covers it');

  const late = newUuid();
  await join(D1, late);
  await service.onLinkUp(identity(D2));
  await current.idle();
  const fresh = await db.collection<OpDoc>('biforesting_ops').find({ type: 'sync_disown', instanceKey: ik(D2) }).sort({ _id: 1 }).toArray();
  assert.equal(fresh.length, 2);
  assert.deepEqual((fresh[1]!.params['entries'] as Array<{ u: string }>).map((e) => e.u), [late]);
});

test('disown: batches carry at most 500 entries', async () => {
  const E1 = 'eeee0001';
  const E2 = 'eeee0002';
  const at = new Date(now());
  const docs = Array.from({ length: 501 }, (_, i) => {
    const u = `11111111-0000-4000-a000-${String(i).padStart(12, '0')}`;
    return { _id: ledgerId('bgrp', u), group: 'bgrp', uuid: u, name: `p${i}`, owner: E1, version: 1, state: 'online', move: null, lease: null, lastSeen: null, shadow: false, disowned: [], updatedAt: at, createdAt: at };
  });
  await db.collection('biforesting_sync_players').insertMany(docs as never[]);
  assert.equal(await current.reconcileDisowns('bgrp', E2), 2);
  const batches = await db.collection<OpDoc>('biforesting_ops').find({ type: 'sync_disown', instanceKey: ik(E2) }).sort({ _id: 1 }).toArray();
  assert.deepEqual(batches.map((b) => (b.params['entries'] as unknown[]).length), [500, 1]);
});

test('disown: a committed move lists its source in disowned, so the source register queues no disown over its away mark', async () => {
  const u = newUuid();
  await seed(u, A, 0);
  const { id } = await toApply(u);
  await answer(await lastOp(u, 'sync_apply'), 'completed', { applied: true, v: 1 });
  const doc = await ledger.get('evol', u);
  assert.deepEqual([doc?.owner, doc?.version, doc?.disowned], [B, 1, [A]]);
  await answer(await lastOp(u, 'sync_commit'), 'completed', { removed: [] });
  assert.equal((await moveOf(id)).step, 'done');

  await service.onLinkUp(identity(A));
  await current.idle();
  const toA = await db.collection<OpDoc>('biforesting_ops').find({ type: 'sync_disown', instanceKey: ik(A), 'params.entries.u': u }).toArray();
  assert.equal(toA.length, 0, 'a disown there would overwrite the move id of the away mark');
  assert.deepEqual((await ledger.get('evol', u))?.disowned, [A]);
});

// ── World-data locks (S3) ────────────────────────────────────────────────────

test('world data: in_transit at release, owned(B) at apply', async () => {
  const u = newUuid();
  await seed(u, A, 0);
  const key = `bp-${u}`;
  const { id } = await toApply(u, [{ h: BP, key }]);
  const transit = await worldData.get('evol', BP, key);
  assert.deepEqual([transit?.state, transit?.owner, transit?.moveId, transit?.lastUuid], ['in_transit', A, id, u]);
  assert.deepEqual((await moveOf(id)).worldData, [{ h: BP, key }]);
  await answer(await lastOp(u, 'sync_apply'), 'completed', { applied: true, v: 1 });
  const owned = await worldData.get('evol', BP, key);
  assert.deepEqual([owned?.state, owned?.owner, owned?.moveId], ['owned', B, null]);
});

test('world data: a key owned by a third instance aborts the move with the key named', async () => {
  const u = newUuid();
  await seed(u, A, 2);
  const mine = `bp-a-${u}`;
  const theirs = `bp-c-${u}`;
  await worldData.forceOwned('evol', BP, theirs, C, newUuid());
  const id = await toRelease(u);
  const m = await moveOf(id);
  const body = Buffer.from('with-backpacks');
  const wd = [{ h: BP, key: mine }, { h: BP, key: theirs }];
  const sha = await upload(A, u, m, body, wd);
  await answer(await lastOp(u, 'sync_release'), 'completed', { sha256: sha, gzLen: body.length, v: 3, worldData: wd });
  const aborted = await moveOf(id);
  assert.equal(aborted.outcome, 'aborted');
  assert.equal(aborted.code, 'error');
  assert.match(aborted.error?.message ?? '', new RegExp(`${BP}:${theirs} is owned by ${C}`));
  const doc = await ledger.get('evol', u);
  assert.deepEqual([doc?.state, doc?.owner, doc?.version], ['online', A, 3]);
  assert.deepEqual([(await worldData.get('evol', BP, mine))?.state, (await worldData.get('evol', BP, mine))?.owner], ['owned', A]);
  assert.equal((await worldData.get('evol', BP, theirs))?.owner, C);
  assert.equal((await opsOf(u, 'sync_apply')).length, 0);
  assert.equal((await lastOp(u, 'sync_abort')).instanceKey, ik(A));
});

// ── Cooldown, mode, refusals ─────────────────────────────────────────────────

test('cooldown: a new move after a committed one is refused with the minutes left', async () => {
  const u = newUuid();
  await seed(u, A, 0);
  const { id } = await toApply(u);
  await answer(await lastOp(u, 'sync_apply'), 'completed', { applied: true, v: 1 });
  assert.equal((await moveOf(id)).outcome, 'committed');
  const err = await rejectsWith(start(u, B, A), 'cooldown');
  assert.equal(err.message, 'You can move again in 10 minutes.');
  assert.equal((err.details as { minutesLeft: number }).minutesLeft, 10);
  offset += 600_001;
  const next = await start(u, B, A);
  assert.equal((await moveOf(next)).step, 'prepare');
  await current.cancelMove('evol', u, next, 'test');
});

test('refusals: mode, frozen, membership, owner, link, feature and fingerprint', async () => {
  const u = newUuid();
  await seed(u, A, 0);
  await rejectsWith(current.startMove('evol', u, { from: A, to: 'zzzz9999', actor: 't' }), 'not_member');
  await rejectsWith(current.startMove('evol', u, { from: B, to: C, actor: 't' }), 'not_owner');
  await groups.upsert('evol', { frozen: true, freezeReason: 'pack update' }, 'test');
  try {
    const frozen = await rejectsWith(start(u), 'frozen');
    assert.equal(frozen.message, 'Moving between instances is paused right now.');
  } finally {
    await groups.upsert('evol', { frozen: false, freezeReason: null }, 'test');
  }
  links.set(B, { instanceKey: ik(B), grantedFeatures: GRANT, fp: 'e'.repeat(64) });
  await rejectsWith(start(u), 'fingerprint_mismatch');
  links.set(B, { instanceKey: ik(B), grantedFeatures: maskForFeatures(['ops']), fp: FP });
  await rejectsWith(start(u), 'feature_off');
  links.delete(B);
  await rejectsWith(start(u), 'no_link');
  links.set(B, { instanceKey: ik(B), grantedFeatures: GRANT, fp: FP });
  await rejectsWith(current.startMove('dgrp-none', u, { from: A, to: B, actor: 't' }), 'mode_off');
  assert.equal(await db.collection('biforesting_sync_moves').countDocuments({ uuid: u }), 0);
  assert.equal((await opsOf(u)).length, 0);
});

test('mode: leaving live stops moves before the apply dispatch; a dispatched apply finishes', async () => {
  const M1 = 'mmmm0001';
  const M2 = 'mmmm0002';
  const x = newUuid();
  const y = newUuid();
  await seed(x, M1, 0);
  await seed(y, M1, 0);
  const early = await start(x, M1, M2);
  await answer(await lastOp(x, 'sync_prepare'), 'completed', { armed: true, online: true });
  const { id: late } = await toApply(y, [], M1, M2);
  assert.equal((await lastOp(y, 'sync_apply')).state, 'dispatched');

  const before = await groups.get('mgrp');
  const after = await groups.upsert('mgrp', { mode: 'shadow' }, 'test');
  await current.onGroupUpdated('mgrp', before, after);
  await current.idle();
  const stopped = await moveOf(early);
  assert.equal(stopped.outcome, 'cancelled');
  assert.equal(stopped.error?.code, 'mode_off');
  assert.equal((await current.getMove('mgrp', x, early)).message, 'Moving between instances is paused right now. Your character stays on Instance 1.');
  assert.equal((await ledger.get('mgrp', x))?.owner, M1);
  assert.equal((await moveOf(late)).step, 'apply', 'the dispatched apply goes on');
  await answer(await lastOp(y, 'sync_apply'), 'completed', { applied: true, v: 1 });
  assert.equal((await moveOf(late)).outcome, 'committed');
  assert.equal((await ledger.get('mgrp', y))?.owner, M2);
  await rejectsWith(current.startMove('mgrp', x, { from: M1, to: M2, actor: 't' }), 'mode_off');
});

// ── Final ops ────────────────────────────────────────────────────────────────

const SYNC_OFF = maskForFeatures(['play_transport', 'ops']);

/** Turns player_sync off on one instance, in the stored policy and on its live link. */
async function syncBit(serverId: string, on: boolean): Promise<void> {
  const mask = on ? GRANT : SYNC_OFF;
  await setPolicy(ik(serverId), { enabledFeatures: mask }, 'test');
  links.set(serverId, { instanceKey: ik(serverId), grantedFeatures: mask, fp: FP });
}

test('final ops: sync_abort to a source with player_sync off waits, burns no attempt, and runs after the grant', async () => {
  const u = newUuid();
  await seed(u, A, 2);
  const { id } = await toApply(u);
  await syncBit(A, false);
  try {
    await answer(await lastOp(u, 'sync_apply'), 'failed', undefined, 'fingerprint_mismatch');
    const first = await lastOp(u, 'sync_abort');
    assert.deepEqual([first.state, first.result?.code], ['failed', 'feature_off'], 'the dispatcher failed it before it left');
    await current.sweep();
    await current.idle();
    const m = await moveOf(id);
    assert.equal(m.step, 'abort', 'the abort step stays open');
    assert.equal(m.error?.code, 'fingerprint_mismatch', 'no abort_failed');
    assert.equal((await opsOf(u, 'sync_abort')).length, 1, 'no new op while the bit is off');
    assert.ok(m.steps.some((s) => s.status === 'parked' && s.opId === first._id));
    const doc = await ledger.get('evol', u);
    assert.deepEqual([doc?.state, doc?.owner, doc?.version], ['online', A, 3], 'the ledger never waits for the abort op');
  } finally {
    await syncBit(A, true);
  }
  await service.onLinkUp(identity(A));
  await current.idle();
  const second = await lastOp(u, 'sync_abort');
  assert.equal(second.idempotencyKey, `sync:evol:${u}:${id}:abort:1`);
  assert.equal(second.state, 'dispatched');
  await answer(second, 'completed', { released: [] });
  const done = await moveOf(id);
  assert.equal(done.step, 'done');
  assert.deepEqual([done.attempts.abort, done.uncounted.abort], [2, 1]);
});

test('final ops: a sync_commit that the mod answers "player sync is inert" waits for a link-up of the source', async () => {
  const u = newUuid();
  await seed(u, A, 0);
  const { id } = await toApply(u);
  await answer(await lastOp(u, 'sync_apply'), 'completed', { applied: true, v: 1 });
  const commit = await lastOp(u, 'sync_commit');
  await dispatcher.onOpRes(commit.instanceKey, { opId: commit._id, phase: 'ack' });
  await dispatcher.onOpRes(commit.instanceKey, { opId: commit._id, phase: 'result', status: 'failed', code: 'not_applied', error: 'player sync is inert on this server (see /bf sync)' });
  await current.idle();
  await current.sweep();
  await current.idle();
  assert.equal((await opsOf(u, 'sync_commit')).length, 1, 'an inert mod gives the same answer again: no retry yet');
  assert.equal((await moveOf(id)).step, 'commit');
  await service.onLinkUp(identity(A));
  await current.idle();
  const again = await lastOp(u, 'sync_commit');
  assert.equal(again.idempotencyKey, `sync:evol:${u}:${id}:commit:1`);
  await answer(again, 'completed', { removed: [] });
  const done = await moveOf(id);
  assert.deepEqual([done.step, done.error, done.uncounted.commit], ['done', null, 1]);
});

// ── Force-release ────────────────────────────────────────────────────────────

/** A player owned by B at v1 after a committed move from A. Returns the move id. */
async function committedOnB(u: string): Promise<{ id: string; body: Buffer }> {
  await seed(u, A, 0);
  const { id, body } = await toApply(u);
  await answer(await lastOp(u, 'sync_apply'), 'completed', { applied: true, v: 1 });
  await answer(await lastOp(u, 'sync_commit'), 'completed', {});
  assert.deepEqual([(await ledger.get('evol', u))?.owner, (await moveOf(id)).step], [B, 'done']);
  return { id, body };
}

async function gateOp(type: 'sync_kick' | 'sync_disown', serverId: string, moveId: string): Promise<OpDoc | null> {
  const key = type === 'sync_kick' ? { $regex: `:${moveId}:kick-${serverId}$` } : `sync:evol:disown:${serverId}:${moveId}`;
  return db.collection<OpDoc>('biforesting_ops').findOne({ type, instanceKey: ik(serverId), idempotencyKey: key });
}

test('force-release: kicks and disowns every old copy first; the apply waits for each disown', async () => {
  const u = newUuid();
  const { body } = await committedOnB(u);
  const view = await current.forceRelease('evol', u, { to: C }, 'staff:alp');
  assert.deepEqual([view.kind, view.step], ['force_release', 'disown']);
  const locked = await ledger.get('evol', u);
  assert.deepEqual([locked?.state, locked?.owner, locked?.version, locked?.move?.step], ['applying', null, 2, 'disown']);
  const m = await moveOf(view.id);
  assert.deepEqual([...m.disownTo].sort(), [A, B].sort(), 'the owner, and the last instance presence saw');

  for (const s of [A, B]) {
    const kick = await gateOp('sync_kick', s, view.id);
    assert.deepEqual(kick?.params, { group: 'evol', message: 'Staff are moving your character. Join again in a minute.', to: C, toLabel: 'Instance 3' });
    const disown = await gateOp('sync_disown', s, view.id);
    assert.deepEqual(disown?.params, { group: 'evol', entries: [{ u, v: 2, to: C, toLabel: 'Instance 3' }] });
  }
  const applies = async (): Promise<OpDoc[]> => (await opsOf(u, 'sync_apply')).filter((op) => op.instanceKey === ik(C));
  assert.equal((await applies()).length, 0, 'no apply before the disowns');
  await answer((await gateOp('sync_disown', A, view.id))!, 'completed', { marked: 1, skipped: 0 });
  assert.equal((await applies()).length, 0, 'B has not disowned yet');
  await answer((await gateOp('sync_disown', B, view.id))!, 'completed', { marked: 1, skipped: 0 });
  const apply = (await applies())[0];
  assert.ok(apply, 'the apply goes out after the last disown');
  assert.deepEqual(sent.find((s) => s.opId === apply._id)?.blob, body);
  assert.equal((await ledger.get('evol', u))?.move?.step, 'apply');

  await answer(apply, 'completed', { applied: true, v: 2 });
  const doc = await ledger.get('evol', u);
  assert.deepEqual([doc?.state, doc?.owner, doc?.version, doc?.move], ['online', C, 2, null]);
  assert.deepEqual([...(doc?.disowned ?? [])].sort(), [A, B].sort());
  assert.equal((await moveOf(view.id)).step, 'done');
});

test('force-release: the commit lists every member whose disown completed, also when the op update never arrived', async () => {
  const u = newUuid();
  await committedOnB(u);
  assert.deepEqual((await ledger.get('evol', u))?.disowned, [A]);
  const view = await current.forceRelease('evol', u, { to: C }, 'staff:alp');
  // A lost op update: the op doc says completed, but recordDisown never ran.
  for (const s of [A, B]) {
    const op = await gateOp('sync_disown', s, view.id);
    assert.ok(op);
    await db.collection<OpDoc>('biforesting_ops').updateOne({ _id: op._id }, { $set: { state: 'completed', result: { ok: true, data: { marked: 1, skipped: 0 } } } });
  }
  assert.deepEqual((await ledger.get('evol', u))?.disowned, [A], 'nothing recorded B yet');
  await current.kick(view.id);
  await current.idle();
  const apply = (await opsOf(u, 'sync_apply')).find((op) => op.instanceKey === ik(C));
  assert.ok(apply, 'the gate saw both disowns completed');
  await answer(apply, 'completed', { applied: true, v: 2 });
  const doc = await ledger.get('evol', u);
  assert.deepEqual([doc?.state, doc?.owner, doc?.version], ['online', C, 2]);
  assert.deepEqual([...(doc?.disowned ?? [])].sort(), [A, B].sort());
});

test('force-release: 409 player_online while presence shows the player on another member; the kick goes with the refusal', async () => {
  const u = newUuid();
  const { id } = await committedOnB(u);
  await join(B, u, { g: 'evol', v: 1, m: id });
  const err = await rejectsWith(current.forceRelease('evol', u, { to: C }, 'staff'), 'player_online');
  assert.equal((err.details as { serverId: string }).serverId, B);
  const kick = await lastOp(u, 'sync_kick');
  assert.equal(kick.instanceKey, ik(B));
  assert.match(kick.idempotencyKey ?? '', new RegExp(`^sync:evol:${u}:online-${B}-\\d+:kick$`));
  await rejectsWith(current.forceRelease('evol', u, { to: C }, 'staff'), 'player_online');
  assert.equal((await opsOf(u, 'sync_kick')).length, 1, 'a retry before the kick lands sends no second kick');
  assert.equal(await db.collection('biforesting_sync_moves').countDocuments({ uuid: u, kind: 'force_release' }), 0);

  await answer(kick, 'completed', { kicked: true });
  const view = await current.forceRelease('evol', u, { to: C }, 'staff');
  assert.equal(view.step, 'disown', 'the completed kick lets it pass, before the quit presence comes');
  await current.cancelMove('evol', u, view.id, 'staff');
});

test('force-release: a stuck ledger goes on past a dead old member and leaves its disown queued', async () => {
  const u = newUuid();
  await seed(u, A, 0);
  const { id } = await toApply(u);
  for (let i = 0; i < 2; i++) {
    await answer(await lastOp(u, 'sync_apply'), 'failed', undefined, 'handler_failed');
    await answer(await lastOp(u, 'sync_probe'), 'completed', { online: false, datExists: true, fp: FP });
  }
  assert.equal((await ledger.get('evol', u))?.state, 'stuck');
  const snapshotId = (await moveOf(id)).snapshotId!;
  liveKeys.delete(ik(B));
  links.delete(B);
  try {
    const view = await current.forceRelease('evol', u, { to: C, snapshotId }, 'staff');
    assert.deepEqual([...(await moveOf(view.id)).disownTo].sort(), [A, B].sort());
    await answer((await gateOp('sync_disown', A, view.id))!, 'completed', { marked: 1, skipped: 0 });
    const queued = await gateOp('sync_disown', B, view.id);
    assert.equal(queued?.state, 'pending', 'the disown to dead B stays queued');
    const apply = (await opsOf(u, 'sync_apply')).find((op) => op.instanceKey === ik(C));
    assert.ok(apply, 'dead B did not block the apply');
    await answer(apply, 'completed', { applied: true, v: 2 });
    const doc = await ledger.get('evol', u);
    assert.deepEqual([doc?.state, doc?.owner, doc?.version], ['online', C, 2]);
  } finally {
    liveKeys.add(ik(B));
    links.set(B, { instanceKey: ik(B), grantedFeatures: GRANT, fp: FP });
  }
});

test('force-release: a failed apply after the disowns goes stuck; a cancel before any disown left puts the ledger back', async () => {
  const u = newUuid();
  await committedOnB(u);
  const view = await current.forceRelease('evol', u, { to: C }, 'staff');
  for (const s of [A, B]) await answer((await gateOp('sync_disown', s, view.id))!, 'completed', { marked: 1, skipped: 0 });
  await answer((await opsOf(u, 'sync_apply')).find((op) => op.instanceKey === ik(C))!, 'failed', undefined, 'fingerprint_mismatch');
  const m = await moveOf(view.id);
  assert.deepEqual([m.outcome, m.step], ['stuck', 'done']);
  assert.match(m.error?.message ?? '', /cannot go back/);
  const doc = await ledger.get('evol', u);
  assert.deepEqual([doc?.state, doc?.owner], ['stuck', null], 'A and B refuse the player now, so no rollback to B');

  const w = newUuid();
  await committedOnB(w);
  liveKeys.delete(ik(A));
  liveKeys.delete(ik(B));
  try {
    const v2 = await current.forceRelease('evol', w, { to: C }, 'staff');
    assert.equal((await gateOp('sync_disown', A, v2.id))?.state, 'pending');
    await current.cancelMove('evol', w, v2.id, 'staff');
    const back = await ledger.get('evol', w);
    assert.deepEqual([back?.state, back?.owner, back?.version, back?.move], ['online', B, 1, null]);
    assert.equal((await moveOf(v2.id)).outcome, 'cancelled');
    assert.equal((await gateOp('sync_disown', A, v2.id))?.state, 'cancelled');
  } finally {
    liveKeys.add(ik(A));
    liveKeys.add(ik(B));
  }
});

test('force-release: the default snapshot is the newest release of a committed move, never one of an aborted move', async () => {
  const u = newUuid();
  const { id } = await committedOnB(u);
  offset += 600_001;
  const later = await toRelease(u, B, A);
  await upload(B, u, await moveOf(later), Buffer.from('aborted-later'));
  await answer(await lastOp(u, 'sync_release'), 'failed', undefined, 'too_large');
  assert.equal((await moveOf(later)).outcome, 'aborted');
  assert.equal((await snapshots.newest('evol', u, 'release'))?.moveId, later, 'the aborted release is the newest');

  const view = await current.forceRelease('evol', u, { to: C }, 'staff');
  assert.equal(view.reason, `force-release of snapshot ${(await moveOf(id)).snapshotId}`);
  await current.cancelMove('evol', u, view.id, 'staff');
});

// ── Long poll ────────────────────────────────────────────────────────────────

test('long poll: answers at the next step change, at the timeout, and at once for a known old step', async () => {
  const u = newUuid();
  await seed(u, A, 0);
  const id = await start(u);
  const t0 = Date.now();
  const waiting = current.waitMove('evol', u, id, 5_000);
  setTimeout(() => {
    void lastOp(u, 'sync_prepare').then((op) => answer(op, 'completed', { armed: true, online: true }));
  }, 30);
  const changed = await waiting;
  assert.equal(changed.step, 'wait_quit');
  assert.ok(Date.now() - t0 < 4_000, 'answered on the change, not the timeout');
  assert.equal(changed.message, 'Moving your character to Instance 2. Join again in a few seconds.');

  const t1 = Date.now();
  const timedOut = await current.waitMove('evol', u, id, 80);
  assert.equal(timedOut.step, 'wait_quit');
  assert.ok(Date.now() - t1 >= 70, 'held until the timeout');

  const t2 = Date.now();
  const known = await current.waitMove('evol', u, id, 5_000, 'prepare');
  assert.equal(known.step, 'wait_quit');
  assert.ok(Date.now() - t2 < 1_000, 'the caller saw prepare, so the answer comes at once');

  await current.cancelMove('evol', u, id, 'test');
  const t3 = Date.now();
  const finished = await current.waitMove('evol', u, id, 5_000);
  assert.equal(finished.outcome, 'cancelled');
  assert.ok(Date.now() - t3 < 1_000, 'a move with an outcome answers at once');
  await assert.rejects(current.waitMove('evol', newUuid(), id, 10), /not found/);
});

/** A runner like {@link mkRunner} with its own dispatch port and ledger store. */
function runnerWith(dispatch: SyncRunnerDeps['dispatch'], ledgerStore: SyncLedgerStore = ledger): SyncRunner {
  return new SyncRunner({
    stores: { groups, ledger: ledgerStore, snapshots, moves, worldData },
    ops: store,
    dispatch,
    directory,
    links: { instance: async (serverId) => links.get(serverId) ?? null },
    holder: 'test-1',
    now,
    schedule: () => undefined,
  });
}

test('start: the 201 view shows step prepare when the prepare result lands during the start', async () => {
  const u = newUuid();
  await seed(u, A, 0);
  const first = current;
  // A fast link: the prepare result is stored before the start drive reads the op again.
  current = runnerWith({
    onOpCreated: async (op) => {
      await dispatcher.onOpCreated(op);
      if (op.type !== 'sync_prepare') return;
      await dispatcher.onOpRes(op.instanceKey, { opId: op._id, phase: 'ack' });
      await dispatcher.onOpRes(op.instanceKey, { opId: op._id, phase: 'result', status: 'completed', result: { armed: true, online: true, links: [] } });
    },
  });
  try {
    const view = await current.startMove('evol', u, { from: A, to: B, actor: 'test' });
    assert.equal(view.step, 'prepare');
    assert.equal(view.outcome, null);
    assert.equal(view.message, 'Getting your character ready to move to Instance 2.');
    assert.equal((await moveOf(view.id)).step, 'wait_quit', 'the prepare result was handled inside the start');
    const known = await current.waitMove('evol', u, view.id, 5_000, view.step);
    assert.equal(known.step, 'wait_quit', 'a long poll from the 201 step answers at once');
    await current.cancelMove('evol', u, view.id, 'test');
    await current.idle();
  } finally {
    current = first;
  }
});

test('long poll: a move with an outcome shows the owner and version of its pending ledger write', async () => {
  // The final ledger write loses its CAS while `hold` is set, as when another process holds the lease.
  let hold = true;
  const gated = Object.create(ledger) as SyncLedgerStore;
  gated.casUpdate = (filter, update) =>
    hold && (update.$set as Record<string, unknown> | undefined)?.['state'] === 'online' ? Promise.resolve(null) : ledger.casUpdate(filter, update);
  const first = current;
  current = runnerWith(dispatcher, gated);
  try {
    for (const [status, code, owner] of [
      ['completed', undefined, B],
      ['failed', 'fingerprint_mismatch', A],
    ] as const) {
      hold = true;
      const u = newUuid();
      await seed(u, A, 2);
      const { id } = await toApply(u);
      await answer(await lastOp(u, 'sync_apply'), status, status === 'completed' ? { applied: true, created: false, already: false, v: 3 } : undefined, code);
      const m = await moveOf(id);
      assert.equal(m.ledgerDone, false, 'the ledger write is still pending');
      assert.equal((await ledger.get('evol', u))?.state, 'applying');
      const view = await current.getMove('evol', u, id);
      assert.deepEqual([view.outcome, view.owner, view.version], [status === 'completed' ? 'committed' : 'aborted', owner, 3]);

      hold = false;
      await current.kick(id);
      await current.idle();
      const doc = await ledger.get('evol', u);
      assert.deepEqual([doc?.state, doc?.owner, doc?.version], ['online', owner, 3]);
      const after = await current.getMove('evol', u, id);
      assert.deepEqual([after.owner, after.version], [owner, 3]);
    }
  } finally {
    current = first;
  }
});

// ── Dispatcher and inertness ─────────────────────────────────────────────────

test('dispatcher: a sync_apply whose snapshot is gone fails with not_applied before it leaves', async () => {
  const u = newUuid();
  const { op } = await store.create({
    instanceKey: ik(B),
    serverTag: 'evol',
    type: 'sync_apply',
    params: { group: 'evol', moveId: 'M', v: 1, sha256: 'a'.repeat(64), fp: FP, snapshotId: 'evol:gone:1:release:x' },
    target: { uuid: u, name: 'Steve' },
    createdBy: 'test',
  });
  const before = sent.length;
  await dispatcher.onOpCreated(op);
  const failed = await store.get(op._id);
  assert.equal(failed?.state, 'failed');
  assert.equal(failed?.result?.code, 'not_applied');
  assert.equal(sent.length, before, 'nothing went down the link');
});

test('inert: with nothing open the sweep reads once, then stops reading', async () => {
  let reads = 0;
  const quietMoves = Object.create(moves) as SyncMovesStore;
  quietMoves.listOpen = async () => {
    reads++;
    return [];
  };
  const quietLedger = Object.create(ledger) as SyncLedgerStore;
  quietLedger.listLapsed = async () => [];
  const runner = new SyncRunner({
    stores: { groups, ledger: quietLedger, snapshots, moves: quietMoves, worldData },
    ops: store,
    dispatch: dispatcher,
    directory,
    links: { instance: async (s) => links.get(s) ?? null },
    holder: 'quiet',
    now,
    schedule: () => undefined,
  });
  assert.equal(await runner.sweep(), 0);
  assert.equal(await runner.sweep(), 0);
  assert.equal(reads, 1);
  await runner.onOpUpdate({ type: 'echo' } as OpDoc);
  await runner.idle();
});

// ── Target probe (spec 6.1) ──────────────────────────────────────────────────

/** The `sync_probe` that the start of move `moveId` sent to its target. */
async function targetProbe(uuid: string, moveId: string): Promise<OpDoc> {
  const op = await db.collection<OpDoc>('biforesting_ops').findOne({ type: 'sync_probe', idempotencyKey: `sync:evol:${uuid}:${moveId}:target-probe` });
  assert.ok(op, `no target probe for move ${moveId}`);
  return op;
}

test('target probe: the move start probes the target; datExists sets targetHasCharacter true or false', async () => {
  for (const has of [true, false]) {
    const u = newUuid();
    await seed(u, A, 0);
    const view = await current.startMove('evol', u, { from: A, to: B, actor: 'test' });
    assert.equal(view.targetHasCharacter, null, 'the 201 view has no answer yet');
    const probe = await targetProbe(u, view.id);
    assert.equal(probe.instanceKey, ik(B));
    assert.deepEqual(probe.params, { group: 'evol' });
    assert.equal(probe.target?.uuid, u);
    assert.ok(sent.some((s) => s.opId === probe._id), 'the probe went down the link');
    assert.equal((await moveOf(view.id)).ops.targetProbe, probe._id);

    await answer(probe, 'completed', { online: false, datExists: has, fp: FP, locks: [] });
    const m = await moveOf(view.id);
    assert.equal(m.targetHasCharacter, has);
    assert.equal(m.step, 'prepare', 'the probe answer moves no step');
    assert.ok(m.steps.some((s) => s.status === 'target_probe' && s.opId === probe._id));
    assert.equal((await current.getMove('evol', u, view.id)).targetHasCharacter, has);
    assert.equal((await current.listMoves('evol', u, 5))[0]?.targetHasCharacter, has);
    await current.cancelMove('evol', u, view.id, 'test');
  }
});

test('target probe: a .dat stamped for this group is the player own copy, so targetHasCharacter is false', async () => {
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ['round trip: an earlier move released this player there', { datExists: true, stamp: { g: 'evol', v: 1, m: 'an-old-move' }, away: { v: 1, m: 'an-old-move', to: A } }, false],
    ['a disown marked this copy away', { datExists: true, stamp: { g: 'evol', v: 3 } }, false],
    ['a .dat with no stamp', { datExists: true }, true],
    ['a stamp of another group', { datExists: true, stamp: { g: 'other', v: 4, m: 'x' } }, true],
    ['no .dat', { datExists: false }, false],
  ];
  for (const [why, body, has] of cases) {
    const u = newUuid();
    await seed(u, A, 0);
    const view = await current.startMove('evol', u, { from: A, to: B, actor: 'test' });
    await answer(await targetProbe(u, view.id), 'completed', { online: false, fp: FP, locks: [], ...body });
    const m = await moveOf(view.id);
    assert.equal(m.targetHasCharacter, has, why);
    assert.equal((await current.getMove('evol', u, view.id)).targetHasCharacter, has, why);
    assert.ok(m.steps.some((s) => s.status === 'target_probe'), why);
    await current.cancelMove('evol', u, view.id, 'test');
  }
});

test('target probe: null while it runs and after a failure; it never blocks the move', async () => {
  const u = newUuid();
  await seed(u, A, 0);
  const { id } = await toApply(u);
  assert.equal((await moveOf(id)).targetHasCharacter, null, 'the move reached apply with no probe answer');
  await answer(await targetProbe(u, id), 'failed', undefined, 'not_applied');
  assert.equal((await moveOf(id)).targetHasCharacter, null, 'a failed probe leaves null');
  await answer(await lastOp(u, 'sync_apply'), 'completed', { applied: true, v: 1 });
  const done = await current.getMove('evol', u, id);
  assert.deepEqual([done.outcome, done.targetHasCharacter], ['committed', null]);

  // A probe that cannot be sent leaves null, and the prepare still goes out.
  const w = newUuid();
  await seed(w, A, 0);
  const first = current;
  current = runnerWith({
    onOpCreated: async (op) => {
      if (op.type === 'sync_probe') throw new Error('test: probe dispatch fails');
      await dispatcher.onOpCreated(op);
    },
  });
  try {
    const view = await current.startMove('evol', w, { from: A, to: B, actor: 'test' });
    const m = await moveOf(view.id);
    assert.ok(m.ops.prepare, 'the prepare went out');
    assert.equal(m.ops.targetProbe, undefined);
    await answer(await lastOp(w, 'sync_prepare'), 'completed', { armed: true, online: true });
    assert.equal((await moveOf(view.id)).step, 'wait_quit');
    await current.cancelMove('evol', w, view.id, 'test');
    await current.idle();
  } finally {
    current = first;
  }
});

test('target probe: its answer wakes a long poll at the same step', async () => {
  const u = newUuid();
  await seed(u, A, 0);
  const id = await start(u);
  const probe = await targetProbe(u, id);
  const t0 = Date.now();
  const waiting = current.waitMove('evol', u, id, 5_000, 'prepare');
  setTimeout(() => {
    void answer(probe, 'completed', { online: false, datExists: true, fp: FP });
  }, 30);
  const woke = await waiting;
  assert.ok(Date.now() - t0 < 4_000, 'answered on the probe, not the timeout');
  assert.deepEqual([woke.step, woke.targetHasCharacter], ['prepare', true]);
  await current.cancelMove('evol', u, id, 'test');
});

// ── Reseed (spec 6.7) ────────────────────────────────────────────────────────

const R1 = 'rrrr0001';
const R2 = 'rrrr0002';
const R3 = 'rrrr0003';

/** Runs `fn` while group `rgrp` is frozen. */
async function whileFrozen<T>(fn: () => Promise<T>): Promise<T> {
  await groups.upsert('rgrp', { frozen: true, freezeReason: 'restore' }, 'test');
  try {
    return await fn();
  } finally {
    await groups.upsert('rgrp', { frozen: false, freezeReason: null }, 'test');
  }
}

async function reseedR1(): Promise<SyncReseedResult> {
  const r = await current.reseed('rgrp', R1, 'vu');
  await current.idle();
  return r;
}

async function kicksOn(uuid: string, serverId: string): Promise<number> {
  return (await opsOf(uuid, 'sync_kick')).filter((k) => k.instanceKey === ik(serverId)).length;
}

async function disownsToR1(): Promise<OpDoc[]> {
  return db.collection<OpDoc>('biforesting_ops').find({ type: 'sync_disown', instanceKey: ik(R1) }).sort({ _id: 1 }).toArray();
}

async function ownsToR1(): Promise<OpDoc[]> {
  return db.collection<OpDoc>('biforesting_ops').find({ type: 'sync_own', instanceKey: ik(R1) }).sort({ _id: 1 }).toArray();
}

function ownEntry(op: OpDoc, uuid: string): { u: string; v: number } | undefined {
  return (op.params['entries'] as Array<{ u: string; v: number }>).find((e) => e.u === uuid);
}

test('reseed: refused unless the group is frozen, and for a server outside the group', async () => {
  await rejectsWith(current.reseed('rgrp', R1, 'vu'), 'not_frozen');
  await whileFrozen(async () => {
    await rejectsWith(current.reseed('rgrp', A, 'vu'), 'not_member');
    await rejectsWith(current.reseed('rgrp', 'zzzz9999', 'vu'), 'not_member');
  });
});

test('reseed: open moves that touch the server close; before the apply went out they abort, after it they go stuck', async () => {
  const early = newUuid(); // R2 to R1, at wait_quit
  const out = newUuid(); // R1 to R2, the apply went out
  const held = newUuid(); // R1 to R3, the apply never left Yggdrasil
  const other = newUuid(); // R2 to R3, does not touch R1
  await seed(early, R2, 2);
  await seed(out, R1, 0);
  await seed(held, R1, 4);
  await seed(other, R2, 0);
  const e = await start(early, R2, R1);
  await answer(await lastOp(early, 'sync_prepare'), 'completed', { armed: true, online: true });
  const { id: s } = await toApply(out, [], R1, R2);
  assert.equal((await lastOp(out, 'sync_apply')).state, 'dispatched');
  liveKeys.delete(ik(R3));
  let h: string;
  try {
    ({ id: h } = await toApply(held, [], R1, R3));
    assert.equal(provablyUnrun(await lastOp(held, 'sync_apply')), true);
  } finally {
    liveKeys.add(ik(R3));
  }
  const o = await start(other, R2, R3);

  const events: Array<AppEventPayload<'biforesting.sync.reseed'>> = [];
  const listener = (p: AppEventPayload<'biforesting.sync.reseed'>): void => {
    events.push(p);
  };
  eventBus.on('biforesting.sync.reseed', listener);
  let r: SyncReseedResult;
  try {
    r = await whileFrozen(reseedR1);
  } finally {
    eventBus.off('biforesting.sync.reseed', listener);
  }
  assert.deepEqual([...r.movesAborted].sort(), [e, h].sort());
  assert.deepEqual(r.movesStuck, [s]);
  assert.equal(events.length, 1);
  assert.deepEqual([events[0]!.group, events[0]!.serverId, events[0]!.actor, events[0]!.movesStuck], ['rgrp', R1, 'vu', [s]]);

  const em = await moveOf(e);
  assert.deepEqual([em.outcome, em.code, em.error?.code, em.cancel?.reason, em.cancel?.serverId], ['cancelled', 'cancelled', 'reseed', 'reseed', R1]);
  assert.equal(em.error?.message, `reseed of ${R1} by vu`);
  const ed = await ledger.get('rgrp', early);
  assert.deepEqual([ed?.state, ed?.owner, ed?.version], ['online', R2, 2]);
  assert.equal((await lastOp(early, 'sync_abort')).instanceKey, ik(R2));

  const sm = await moveOf(s);
  assert.deepEqual([sm.outcome, sm.step], ['stuck', 'done']);
  assert.match(sm.error?.message ?? '', /the apply went out to rrrr0002/);
  assert.equal((await ledger.get('rgrp', out))?.state, 'stuck');
  assert.equal((await lastOp(out, 'sync_apply')).state, 'cancelled', 'the apply is cancelled too, so it never goes out again');

  const hm = await moveOf(h);
  assert.deepEqual([hm.outcome, hm.error?.code], ['cancelled', 'reseed']);
  assert.equal((await lastOp(held, 'sync_apply')).state, 'cancelled');
  const hd = await ledger.get('rgrp', held);
  assert.deepEqual([hd?.state, hd?.owner, hd?.version, hd?.trustDisk], ['online', R1, 5, true], 'the release ran: n+1, and R1 owns it again');
  assert.equal((await lastOp(held, 'sync_abort')).instanceKey, ik(R1));

  const om = await moveOf(o);
  assert.deepEqual([om.outcome, om.cancel], [null, null], 'a move that does not touch R1 goes on');
  await current.cancelMove('rgrp', other, o, 'test');
});

test('reseed: the owner takes its stamp at its next join or snapshot without a kick; a join on another member still kicks', async () => {
  const u = newUuid();
  const w = newUuid();
  await seed(u, R1, 3);
  await seed(w, R1, 2);
  const r = await whileFrozen(reseedR1);
  assert.ok(r.trusted >= 2, `trusted ${r.trusted}`);
  assert.equal((await ledger.get('rgrp', u))?.trustDisk, true);

  await join(R2, u, { g: 'rgrp', v: 1 });
  assert.equal(await kicksOn(u, R2), 1, 'a join on another member kicks as usual');
  assert.equal(await db.collection('biforesting_ops').countDocuments({ type: 'sync_disown', instanceKey: ik(R2), 'params.entries.u': u }), 1);
  let doc = await ledger.get('rgrp', u);
  assert.deepEqual([doc?.owner, doc?.version, doc?.trustDisk], [R1, 3, true], 'that join changes nothing');

  await join(R1, u, { g: 'rgrp', v: 1, m: 'an-old-move' });
  assert.equal(await kicksOn(u, R1), 0, 'the owner is not kicked');
  doc = await ledger.get('rgrp', u);
  assert.deepEqual([doc?.state, doc?.owner, doc?.version, doc?.trustDisk], ['online', R1, 1, undefined]);
  await join(R1, u, { g: 'rgrp', v: 0 });
  assert.equal(await kicksOn(u, R1), 1, 'trustDisk is used up: a stale stamp kicks again');

  // A snapshot entry with no stamp reads as version 0.
  await service.onPresence(identity(R1), { event: 'snapshot', player: null, online: [{ uuid: w, name: 'Steve' }] });
  await current.idle();
  const wd = await ledger.get('rgrp', w);
  assert.deepEqual([wd?.version, wd?.trustDisk, await kicksOn(w, R1)], [0, undefined, 0]);
});

test('reseed: disowns go to the restored member again, wait for its link, and fill disowned when they complete', async () => {
  const x = newUuid();
  const y = newUuid();
  await seed(x, R2, 1);
  await seed(y, R3, 2);
  // Before the restore, R1 completed a disown for every player of R2 and R3.
  await current.reconcileDisowns('rgrp', R1);
  for (const op of await disownsToR1()) {
    if (op.state !== 'completed') await answer(op, 'completed', { marked: 1, skipped: 0 });
  }
  for (const u of [x, y]) assert.ok((await ledger.get('rgrp', u))?.disowned.includes(R1));
  const before = (await disownsToR1()).length;

  // R1 is still down at the reseed: its disowns wait for its next register.
  links.delete(R1);
  let r: SyncReseedResult;
  try {
    r = await whileFrozen(reseedR1);
  } finally {
    links.set(R1, { instanceKey: ik(R1), grantedFeatures: GRANT, fp: FP });
  }
  assert.equal(r.disownBatches, 0);
  assert.ok(r.disownsQueued >= 2, `disownsQueued ${r.disownsQueued}`);
  assert.equal((await disownsToR1()).length, before, 'nothing queued while R1 has no link');
  for (const u of [x, y]) assert.equal((await ledger.get('rgrp', u))?.disowned.includes(R1), false);

  await service.onLinkUp(identity(R1));
  await current.idle();
  const fresh = (await disownsToR1()).slice(before);
  assert.equal(fresh.length, 1);
  const entries = fresh[0]!.params['entries'] as Array<{ u: string; v: number; to: string; toLabel: string }>;
  assert.deepEqual(
    entries.filter((e) => e.u === x || e.u === y).map((e) => [e.u, e.v, e.to, e.toLabel]),
    [
      [x, 1, R2, 'Instance 2'],
      [y, 2, R3, 'Instance 3'],
    ],
  );
  await answer(fresh[0]!, 'completed', { marked: entries.length, skipped: 0 });
  for (const u of [x, y]) assert.ok((await ledger.get('rgrp', u))?.disowned.includes(R1));

  // With the link up, the reseed queues the batch at once.
  const live = await whileFrozen(reseedR1);
  assert.equal(live.disownBatches, 1);
  const all = await disownsToR1();
  const last = all[all.length - 1]!;
  assert.ok((last.params['entries'] as Array<{ u: string }>).some((e) => e.u === x));
  await answer(last, 'completed', { marked: 1, skipped: 0 });
});

test('reseed: docs the server owns get sync_own; it waits for the link, goes again after a failure, and its completion clears ownPending', async () => {
  const u = newUuid(); // owned by R1
  const x = newUuid(); // owned by R1, joins R1 before its sync_own completes
  const w = newUuid(); // owned by R2
  await seed(u, R1, 3);
  await seed(x, R1, 2);
  await seed(w, R2, 1);
  const pending = async (uuid: string): Promise<string | undefined> =>
    (await db.collection<SyncPlayerDoc>('biforesting_sync_players').findOne({ _id: ledgerId('rgrp', uuid) }))?.ownPending;
  const batchesFor = async (uuid: string): Promise<OpDoc[]> => (await ownsToR1()).filter((op) => ownEntry(op, uuid) !== undefined);

  // R1 is still down at the reseed: its batch waits for the next register.
  links.delete(R1);
  let r: SyncReseedResult;
  try {
    r = await whileFrozen(reseedR1);
  } finally {
    links.set(R1, { instanceKey: ik(R1), grantedFeatures: GRANT, fp: FP });
  }
  assert.equal(r.ownBatches, 0);
  assert.deepEqual([await pending(u), await pending(x), await pending(w)], [R1, R1, undefined]);
  assert.equal((await batchesFor(u)).length, 0);

  await service.onLinkUp(identity(R1));
  await current.idle();
  const [first] = await batchesFor(u);
  assert.ok(first, 'the register of R1 queues the batch');
  assert.deepEqual([ownEntry(first, u), ownEntry(first, x), ownEntry(first, w)], [{ u, v: 3 }, { u: x, v: 2 }, undefined]);
  assert.equal(first.target, null);
  assert.match(first.idempotencyKey ?? '', /^sync:rgrp:own:rrrr0001:/);

  // The login of x passed on R1: its join takes the stamp and ends ownPending.
  await join(R1, x, { g: 'rgrp', v: 2 });
  assert.equal(await pending(x), undefined);
  assert.equal(await kicksOn(x, R1), 0);

  // A failure keeps ownPending, and the next link-up sends the batch again.
  await answer(first, 'failed', undefined, 'not_applied');
  assert.equal(await pending(u), R1);
  await service.onLinkUp(identity(R1));
  await current.idle();
  const batches = await batchesFor(u);
  assert.equal(batches.length, 2);
  assert.equal(ownEntry(batches[1]!, x), undefined, 'x needs no sync_own any more');
  await answer(batches[1]!, 'completed', { cleared: 1, kept: 0 });
  assert.equal(await pending(u), undefined);
  await service.onLinkUp(identity(R1));
  await current.idle();
  assert.equal((await batchesFor(u)).length, 2, 'nothing left to queue');

  // With the link up, the reseed queues at once. A second call while that batch is open adds none.
  const live = await whileFrozen(reseedR1);
  assert.ok(live.ownBatches >= 1, `ownBatches ${live.ownBatches}`);
  assert.equal((await batchesFor(u)).length, 3);
  const again = await whileFrozen(reseedR1);
  assert.equal(again.ownBatches, 0, 'the open batch covers every owned doc');
  for (const op of await ownsToR1()) {
    if (op.state === 'dispatched' || op.state === 'acked') await answer(op, 'completed', { cleared: 0, kept: 0 });
  }
  assert.equal(await pending(u), undefined);
});

test('reseed: a second call does no harm', async () => {
  const u = newUuid(); // R2 to R1, at prepare
  const v = newUuid(); // owned by R1
  const x = newUuid(); // owned by R2
  await seed(u, R2, 0);
  await seed(v, R1, 2);
  await seed(x, R2, 1);
  const m = await start(u, R2, R1);
  const [a, b] = await whileFrozen(async () => [await reseedR1(), await reseedR1()] as const);
  assert.deepEqual([a.movesAborted, a.movesStuck], [[m], []]);
  assert.deepEqual([b.movesAborted, b.movesStuck], [[], []], 'the closed move stays closed');
  assert.equal(b.trusted, a.trusted);
  assert.equal(b.disownsQueued, a.disownsQueued);
  assert.equal(b.disownBatches, 0, 'the open batch of the first call covers every player');
  const mv = await moveOf(m);
  assert.deepEqual([mv.outcome, mv.error?.code], ['cancelled', 'reseed']);
  assert.equal(mv.steps.filter((s) => s.status === 'abort').length, 1);
  assert.equal((await opsOf(u, 'sync_abort')).length, 1);
  const ud = await ledger.get('rgrp', u);
  assert.deepEqual([ud?.state, ud?.owner, ud?.version], ['online', R2, 0]);
  const vd = await ledger.get('rgrp', v);
  assert.deepEqual([vd?.owner, vd?.version, vd?.trustDisk], [R1, 2, true]);

  await join(R1, v, { g: 'rgrp', v: 2 });
  assert.equal(await kicksOn(v, R1), 0);
  const after = await ledger.get('rgrp', v);
  assert.deepEqual([after?.version, after?.trustDisk], [2, undefined]);
  for (const op of await disownsToR1()) {
    if (op.state !== 'completed') await answer(op, 'completed', { marked: 1, skipped: 0 });
  }
});

// ── World-data locks after a reseed (spec 6.7) ───────────────────────────────

async function locksToR1(): Promise<OpDoc[]> {
  return db.collection<OpDoc>('biforesting_ops').find({ type: 'sync_lock', instanceKey: ik(R1) }).sort({ _id: 1 }).toArray();
}

function lockEntry(op: OpDoc, key: string): { h: string; key: string; to: string; toLabel: string } | undefined {
  return (op.params['entries'] as Array<{ h: string; key: string; to: string; toLabel: string }>).find((e) => e.key === key);
}

async function lockPending(key: string): Promise<string[] | undefined> {
  return (await worldData.get('rgrp', BP, key))?.lockPending;
}

test('reseed: world data of another owner, or in transit, gets a sync_lock to the restored member; lockBatches counts the ops', async () => {
  const theirs = `bp-r2-${newUuid()}`; // owned by R2
  const mine = `bp-r1-${newUuid()}`; // owned by R1
  const moving = `bp-mv-${newUuid()}`; // in transit from R2 to R3; the move does not touch R1
  await worldData.forceOwned('rgrp', BP, theirs, R2, newUuid());
  await worldData.forceOwned('rgrp', BP, mine, R1, newUuid());
  const u = newUuid();
  await seed(u, R2, 0);
  const { id } = await toApply(u, [{ h: BP, key: moving }], R2, R3);
  assert.equal((await worldData.get('rgrp', BP, moving))?.state, 'in_transit');
  const before = (await locksToR1()).length;

  const r = await whileFrozen(reseedR1);
  assert.equal(r.lockBatches, 1);
  const batch = (await locksToR1()).slice(before);
  assert.equal(batch.length, 1);
  const op = batch[0]!;
  assert.equal(op.target, null);
  assert.match(op.idempotencyKey ?? '', /^sync:rgrp:lock:rrrr0001:/);
  assert.ok(sent.some((s) => s.opId === op._id && s.type === 'sync_lock'), 'the batch went down the link');
  assert.deepEqual(lockEntry(op, theirs), { h: BP, key: theirs, to: R2, toLabel: 'Instance 2' });
  assert.deepEqual(lockEntry(op, moving), { h: BP, key: moving, to: R3, toLabel: 'Instance 3' }, 'in transit: the move target');
  assert.equal(lockEntry(op, mine), undefined, 'R1 owns this record');
  assert.deepEqual([await lockPending(theirs), await lockPending(moving), await lockPending(mine)], [[R1], [R1], undefined]);

  // A second call while the batch is open adds none.
  const again = await whileFrozen(reseedR1);
  assert.equal(again.lockBatches, 0, 'the open batch covers every record');

  await answer(op, 'completed', { locked: 2, kept: 0 });
  assert.deepEqual([await lockPending(theirs), await lockPending(moving)], [[], []]);
  await service.onLinkUp(identity(R1));
  await current.idle();
  assert.equal((await locksToR1()).length, before + 1, 'nothing left to lock');

  // The move goes on; the apply settles its record on R3.
  await answer(await lastOp(u, 'sync_apply'), 'completed', { applied: true, v: 1 });
  assert.deepEqual([(await worldData.get('rgrp', BP, moving))?.owner, (await moveOf(id)).outcome], [R3, 'committed']);
  await answer(await lastOp(u, 'sync_commit'), 'completed', { removed: [{ h: BP, key: moving }] });
});

test('reseed: sync_lock is a final op; no verdict waits for the next register, a verdict failure goes out again up to 5 times', async () => {
  const k = `bp-final-${newUuid()}`;
  const back = `bp-back-${newUuid()}`; // R1 owns it again before its link comes up
  await worldData.forceOwned('rgrp', BP, k, R2, newUuid());
  await worldData.forceOwned('rgrp', BP, back, R3, newUuid());
  const forK = async (): Promise<OpDoc[]> => (await locksToR1()).filter((op) => lockEntry(op, k) !== undefined);

  // R1 is down at the reseed: the batch waits for its next register.
  links.delete(R1);
  let r: SyncReseedResult;
  try {
    r = await whileFrozen(reseedR1);
  } finally {
    links.set(R1, { instanceKey: ik(R1), grantedFeatures: GRANT, fp: FP });
  }
  assert.equal(r.lockBatches, 0);
  assert.deepEqual(await lockPending(k), [R1]);
  assert.equal((await forK()).length, 0);
  await worldData.forceOwned('rgrp', BP, back, R1, newUuid());
  assert.deepEqual(await lockPending(back), [], 'the new owner needs no lock');

  await service.onLinkUp(identity(R1));
  await current.idle();
  let ops = await forK();
  assert.equal(ops.length, 1, 'the register of R1 queues the batch');
  assert.equal(lockEntry(ops[0]!, back), undefined);

  // No verdict (the bit was off there): it waits for the next register.
  await answer(ops[0]!, 'failed', undefined, 'feature_off');
  assert.equal((await forK()).length, 1, 'no verdict, no retry');
  assert.deepEqual(await lockPending(k), [R1]);
  await service.onLinkUp(identity(R1));
  await current.idle();
  ops = await forK();
  assert.equal(ops.length, 2);

  // A verdict counts: the batch goes out again at once, five failures at most.
  for (let i = 0; i < 5; i++) await answer((await forK()).at(-1)!, 'failed', undefined, 'not_applied');
  ops = await forK();
  assert.equal(ops.length, 6, 'four retries after the first counted failure, none after the fifth');
  assert.deepEqual(await lockPending(k), [R1]);

  // The next register starts over, and a completion ends it.
  await service.onLinkUp(identity(R1));
  await current.idle();
  ops = await forK();
  assert.equal(ops.length, 7);
  await answer(ops.at(-1)!, 'completed', { locked: 1, kept: 0 });
  assert.deepEqual(await lockPending(k), []);
  await service.onLinkUp(identity(R1));
  await current.idle();
  assert.equal((await forK()).length, 7, 'nothing left to queue');
});

test('reseed: a record that the restored member owned before an aborted move gets no lock', async () => {
  const u = newUuid();
  const key = `bp-abort-${newUuid()}`;
  await seed(u, R1, 0);
  // R1 to R2, released; the apply never left Yggdrasil, so the reseed aborts the move.
  liveKeys.delete(ik(R2));
  let id: string;
  try {
    ({ id } = await toApply(u, [{ h: BP, key }], R1, R2));
  } finally {
    liveKeys.add(ik(R2));
  }
  assert.equal((await worldData.get('rgrp', BP, key))?.state, 'in_transit');
  const before = (await locksToR1()).length;
  const r = await whileFrozen(reseedR1);
  assert.deepEqual(r.movesAborted, [id]);
  const doc = await worldData.get('rgrp', BP, key);
  assert.deepEqual([doc?.state, doc?.owner, doc?.lockPending ?? []], ['owned', R1, []], 'the abort gave the record back first');
  assert.ok((await locksToR1()).slice(before).every((op) => lockEntry(op, key) === undefined));
  for (const op of (await locksToR1()).slice(before)) await answer(op, 'completed', { locked: 0, kept: 0 });
});
