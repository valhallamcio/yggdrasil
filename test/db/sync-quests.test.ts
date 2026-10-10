import '../helpers/env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Db } from 'mongodb';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import { startTestMongo, type TestMongo } from '../helpers/mongo.ts';
import { Reader } from '../../src/plugins/biforesting-link/frame-codec.ts';
import { OpsStore } from '../../src/plugins/biforesting-link/ops-store.ts';
import { OpDispatcher } from '../../src/plugins/biforesting-link/op-dispatcher.ts';
import { setPolicy, setPolicyDbProvider, maskForFeatures } from '../../src/plugins/biforesting-link/policy-store.ts';
import { SyncGroupsStore } from '../../src/plugins/biforesting-link/sync-groups-store.ts';
import { SyncLedgerStore, ledgerId } from '../../src/plugins/biforesting-link/sync-ledger-store.ts';
import { SyncSnapshotStore } from '../../src/plugins/biforesting-link/sync-snapshot-store.ts';
import { SyncMovesStore } from '../../src/plugins/biforesting-link/sync-moves-store.ts';
import { SyncWorldDataStore } from '../../src/plugins/biforesting-link/sync-worlddata-store.ts';
import { SyncQuestMergesStore, questMergeId, type SyncQuestMergeDoc } from '../../src/plugins/biforesting-link/sync-quest-merges-store.ts';
import { SyncRunner, SyncConflictError, SYNC_MESSAGES, type SyncRunnerDirectory } from '../../src/plugins/biforesting-link/sync-runner.ts';
import { SyncQuests, QuestOpError, type SyncQuestsTiming } from '../../src/plugins/biforesting-link/sync-quests.ts';
import type { SyncInstanceLink } from '../../src/plugins/biforesting-link/sync-service.ts';
import type { GroupMember } from '../../src/plugins/biforesting-link/server-resolver.ts';
import type { OpDoc, OpTarget } from '../../src/plugins/biforesting-link/types.ts';
import { AppError } from '../../src/shared/errors/index.ts';

/**
 * Quest progress REST (phase6 DESIGN 4 and 7) over mem-mongo: the ops go out through the real ops
 * store and dispatcher to a fake send port, and the tests answer them as the mod would.
 */

let mongo: TestMongo;
let db: Db;
let store: OpsStore;
let dispatcher: OpDispatcher;
let groups: SyncGroupsStore;
let ledger: SyncLedgerStore;
let merges: SyncQuestMergesStore;
let snapshots: SyncSnapshotStore;
let runner: SyncRunner;
let quests: SyncQuests;
/** Short waits for the timeout cases. */
let quick: SyncQuests;

const FP = 'f'.repeat(64);
const Q1 = 'qqqq0001';
const Q2 = 'qqqq0002';
const Q3 = 'qqqq0003';
const OFF = 'oooo0001';
const T1 = '11111111-0000-4000-8000-000000000001';
const T2 = '22222222-0000-4000-8000-000000000002';

const memberships = new Map<string, { group: string; n: number }>([
  [Q1, { group: 'qg', n: 1 }],
  [Q2, { group: 'qg', n: 2 }],
  [Q3, { group: 'qg', n: 3 }],
  [OFF, { group: 'qoff', n: 1 }],
]);
const ik = (serverId: string): string => `ik-${serverId}`;
const GRANT = maskForFeatures(['play_transport', 'ops', 'player_sync']);
const links = new Map<string, SyncInstanceLink>();
const liveKeys = new Set<string>();

interface Sent {
  instanceKey: string;
  opId: string;
  type: string;
  params: Record<string, unknown>;
  target: OpTarget | null;
  /** The v2 envelope blob, or null. */
  blob: Buffer | null;
}
const sent: Sent[] = [];
const taken = new Set<string>();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function decodeOp(payload: Buffer): Omit<Sent, 'instanceKey'> {
  const r = new Reader(payload);
  const ver = r.varInt();
  const json = JSON.parse(r.utf()) as { opId: string; type: string; params: Record<string, unknown>; target: OpTarget | null };
  const blob = ver === 2 ? Buffer.from(r.bytes(r.varInt())) : null;
  return { opId: json.opId, type: json.type, params: json.params, target: json.target, blob };
}

const directory: SyncRunnerDirectory = {
  groupOf: async (serverId) => memberships.get(serverId)?.group ?? null,
  groupMembers: async (group) =>
    [...memberships.entries()]
      .filter(([, m]) => m.group === group)
      .map(([serverId, m]): GroupMember => ({ serverId, instanceNumber: m.n, name: serverId })),
  instanceOf: async (serverId) => (memberships.has(serverId) ? { instanceKey: ik(serverId), tag: memberships.get(serverId)!.group } : null),
};

function mkQuests(timing: Partial<SyncQuestsTiming>): SyncQuests {
  return new SyncQuests({
    stores: { groups, ledger, merges, snapshots },
    ops: store,
    dispatch: dispatcher,
    directory,
    links: { instance: async (serverId) => links.get(serverId) ?? null },
    timing,
  });
}

before(async () => {
  mongo = await startTestMongo();
  db = mongo.client.db('ygg_sync_quests_test');
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
  groups = new SyncGroupsStore(() => db);
  ledger = new SyncLedgerStore(() => db);
  snapshots = new SyncSnapshotStore(() => db, ledger);
  const moves = new SyncMovesStore(() => db);
  const worldData = new SyncWorldDataStore(() => db);
  merges = new SyncQuestMergesStore(() => db);
  for (const s of [groups, ledger, snapshots, moves, worldData, merges]) await s.ensureIndexes();
  runner = new SyncRunner({
    stores: { groups, ledger, snapshots, moves, worldData },
    ops: store,
    dispatch: dispatcher,
    directory,
    links: { instance: async (serverId) => links.get(serverId) ?? null },
    holder: 'test-runner',
    schedule: () => undefined,
  });
  dispatcher.setSyncSnapshots(snapshots);
  quests = mkQuests({ statusMs: 3_000, actionMs: 3_000, candidatesMs: 3_000, mergeMs: 5_000, pollMs: 25 });
  quick = mkQuests({ statusMs: 700, actionMs: 700, candidatesMs: 700, mergeMs: 1_500, pollMs: 25 });
  dispatcher.setUpdateHook(async (op) => {
    await Promise.all([runner.onOpUpdate(op), quests.onOpUpdate(op), quick.onOpUpdate(op)]);
  });
  for (const serverId of memberships.keys()) {
    await setPolicy(ik(serverId), { enabledFeatures: GRANT }, 'test');
    links.set(serverId, { instanceKey: ik(serverId), grantedFeatures: GRANT, fp: FP });
    liveKeys.add(ik(serverId));
  }
  await groups.upsert('qg', { mode: 'live' }, 'test');
});
after(async () => mongo.stop());

// ── Helpers ──────────────────────────────────────────────────────────────────

let seq = 0;
const newUuid = (): string => `00000000-0000-4000-b000-${String(++seq).padStart(12, '0')}`;

/** A ledger doc `online` on `owner` at version 0. */
async function seed(uuid: string, owner: string): Promise<void> {
  const group = memberships.get(owner)!.group;
  await ledger.upsertFromPresence(group, uuid, 'Steve', owner, 'join', null, 'live');
}

/** The next op of `type` sent to `serverId` that no test took yet. */
async function nextSent(type: string, serverId: string, timeoutMs = 3_000): Promise<Sent> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const s = sent.find((x) => x.type === type && x.instanceKey === ik(serverId) && !taken.has(x.opId));
    if (s) {
      taken.add(s.opId);
      return s;
    }
    if (Date.now() > until) throw new Error(`no ${type} op went to ${serverId}`);
    await sleep(5);
  }
}

function sentOf(type: string, serverId?: string): Sent[] {
  return sent.filter((x) => x.type === type && (serverId === undefined || x.instanceKey === ik(serverId)));
}

async function ack(s: Sent): Promise<void> {
  await dispatcher.onOpRes(s.instanceKey, { opId: s.opId, phase: 'ack' });
}

async function reply(s: Sent, status: 'completed' | 'failed' | 'waiting_player', result?: unknown, code?: string): Promise<void> {
  await ack(s);
  await dispatcher.onOpRes(s.instanceKey, {
    opId: s.opId,
    phase: 'result',
    status,
    ...(result !== undefined ? { result } : {}),
    ...(code ? { code, error: `mod says ${code}` } : {}),
  });
}

function rejectsWith(code: string, status = 409): (err: unknown) => boolean {
  return (err: unknown) => {
    assert.ok(err instanceof AppError, `expected an AppError, got ${String(err)}`);
    assert.equal(err.code, code);
    assert.equal(err.statusCode, status);
    return true;
  };
}

async function opDoc(opId: string): Promise<OpDoc> {
  const op = await store.get(opId);
  assert.ok(op, opId);
  return op;
}

const partyBook = (teamId: string): Record<string, unknown> => ({ book: { kind: 'party', teamId: teamId.toUpperCase(), name: 'One', members: [] }, done: 2 });

// ── status ───────────────────────────────────────────────────────────────────

test('status: quests_status goes to the owner; the answer is the mod result plus the owner', async () => {
  const u = newUuid();
  await seed(u, Q1);
  const p = quests.status('qg', u, 'test');
  const s = await nextSent('quests_status', Q1);
  assert.deepEqual(s.params, { group: 'qg', uuid: u });
  assert.deepEqual(s.target, { uuid: u, name: 'Steve' });
  await reply(s, 'completed', { book: { kind: 'player', teamId: u, name: 'Steve', members: [] }, done: 3, pref: 'merge', backups: [] });
  const view = await p;
  assert.equal(view['owner'], Q1);
  assert.equal(view['ownerLabel'], 'Instance 1');
  assert.equal(view['done'], 3);
  assert.equal(view['pref'], 'merge');
  assert.equal((await ledger.get('qg', u))?.lease, null, 'status takes no lock');
});

test('status refusals: no ledger doc, mode off, a move, stuck, owner without a link or player_sync', async () => {
  const before = sentOf('quests_status').length;
  await assert.rejects(quests.status('qg', newUuid(), 'test'), rejectsWith('NOT_FOUND', 404));

  const off = newUuid();
  await seed(off, OFF);
  await assert.rejects(quests.status('qoff', off, 'test'), rejectsWith('mode_off'));

  const u = newUuid();
  await seed(u, Q1);
  const id = ledgerId('qg', u);
  await ledger.casUpdate({ _id: id }, { $set: { state: 'moving', move: { id: 'M1', from: Q1, to: Q2, step: 'prepare', startedAt: new Date(), updatedAt: new Date() } } });
  await assert.rejects(quests.status('qg', u, 'test'), rejectsWith('moving'));
  await ledger.casUpdate({ _id: id }, { $set: { state: 'stuck' } });
  await assert.rejects(quests.status('qg', u, 'test'), rejectsWith('stuck'));
  await ledger.casUpdate({ _id: id }, { $set: { state: 'online', move: null } });

  await ledger.casUpdate({ _id: id }, { $set: { state: 'applying', owner: null } });
  await assert.rejects(quests.status('qg', u, 'test'), rejectsWith('applying'));
  await ledger.casUpdate({ _id: id }, { $set: { state: 'online', move: null, owner: null } });
  await assert.rejects(quests.status('qg', u, 'test'), rejectsWith('not_online'));
  await ledger.casUpdate({ _id: id }, { $set: { owner: Q1 } });

  links.delete(Q1);
  try {
    await assert.rejects(quests.status('qg', u, 'test'), rejectsWith('instance_offline'));
  } finally {
    links.set(Q1, { instanceKey: ik(Q1), grantedFeatures: GRANT, fp: FP });
  }
  links.set(Q1, { instanceKey: ik(Q1), grantedFeatures: maskForFeatures(['ops']), fp: FP });
  try {
    await assert.rejects(quests.status('qg', u, 'test'), rejectsWith('feature_missing'));
  } finally {
    links.set(Q1, { instanceKey: ik(Q1), grantedFeatures: GRANT, fp: FP });
  }
  assert.equal(sentOf('quests_status').length, before, 'no refusal sends an op');
});

// ── action ───────────────────────────────────────────────────────────────────

test('action: the quest lock holds while the op runs; a move start gets 409 moving; the answer frees it', async () => {
  const u = newUuid();
  await seed(u, Q1);
  const p = quests.action('qg', u, { action: 'pref', value: 'separate' }, 'test');
  const s = await nextSent('quests_action', Q1);
  assert.deepEqual(s.params, { group: 'qg', uuid: u, action: 'pref', value: 'separate' });
  assert.match((await ledger.get('qg', u))?.lease?.holder ?? '', /^quests:/);

  await assert.rejects(runner.startMove('qg', u, { from: Q1, to: Q2, actor: 'test' }), (err: unknown) => {
    assert.ok(err instanceof SyncConflictError);
    assert.equal(err.code, 'moving');
    assert.equal(err.message, SYNC_MESSAGES.questsBusy);
    return true;
  });
  await assert.rejects(quests.action('qg', u, { action: 'fresh' }, 'test'), rejectsWith('busy'));

  await reply(s, 'completed', { ok: true, backupId: null });
  const view = await p;
  assert.equal(view['ok'], true);
  assert.equal(view['owner'], Q1);
  assert.equal((await ledger.get('qg', u))?.lease, null, 'the lock is gone');

  const move = await runner.startMove('qg', u, { from: Q1, to: Q2, actor: 'test' });
  assert.equal(move.step, 'prepare', 'a move starts once the lock is gone');

  // The move is open now: an action is refused and sends nothing.
  const actions = sentOf('quests_action').length;
  await assert.rejects(quests.action('qg', u, { action: 'fresh' }, 'test'), rejectsWith('moving'));
  await assert.rejects(quests.partyMerge('qg', u, { fromServer: Q2, teamId: T2 }, 'test'), rejectsWith('moving'));
  assert.equal(sentOf('quests_action').length, actions);
});

test('action: the mod refusal (ok false) comes back as 200 data; undo carries the backupId', async () => {
  const u = newUuid();
  await seed(u, Q1);
  const p = quests.action('qg', u, { action: 'undo', backupId: '20261010T193000Z-fresh' }, 'test');
  const s = await nextSent('quests_action', Q1);
  assert.deepEqual(s.params, { group: 'qg', uuid: u, action: 'undo', backupId: '20261010T193000Z-fresh' });
  await reply(s, 'completed', { ok: false, code: 'too_old' });
  const view = await p;
  assert.equal(view['ok'], false);
  assert.equal(view['code'], 'too_old');
});

test('action: an old mod answers unsupported_op: 409 not_ready at once, the lock goes; a mod code passes through', async () => {
  const u = newUuid();
  await seed(u, Q1);
  const p = quests.action('qg', u, { action: 'fresh' }, 'test');
  const s = await nextSent('quests_action', Q1);
  await reply(s, 'failed', undefined, 'unsupported_op');
  await assert.rejects(p, rejectsWith('not_ready'));
  assert.equal((await ledger.get('qg', u))?.lease, null);

  const q = quests.action('qg', u, { action: 'fresh' }, 'test');
  await reply(await nextSent('quests_action', Q1), 'failed', undefined, 'move_mark');
  await assert.rejects(q, rejectsWith('move_mark'));
});

test('action: no result in time: 409 timeout; a dispatched op is cancelled, an acked one runs on; the lock stays until it lapses', async () => {
  const u = newUuid();
  await seed(u, Q1);
  const started = Date.now();
  const p = quick.action('qg', u, { action: 'fresh' }, 'test');
  const s = await nextSent('quests_action', Q1);
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof QuestOpError);
    assert.equal(err.code, 'timeout');
    assert.equal(err.statusCode, 409);
    assert.equal(err.unsettled, true, 'it went out, so the mod may still run it');
    return true;
  });
  assert.ok(Date.now() - started < 2_000, 'the call ends with its budget');
  const op = await opDoc(s.opId);
  assert.equal(op.state, 'cancelled');
  assert.ok(op.expiresAt.getTime() - op.createdAt.getTime() <= 700, 'the op expires with the budget, so the mod refuses it later');
  const lease = (await ledger.get('qg', u))?.lease;
  assert.match(lease?.holder ?? '', /^quests:/);
  assert.ok(lease && lease.until.getTime() > op.expiresAt.getTime() + 20_000, 'the lock outlasts a late run');
  await assert.rejects(runner.startMove('qg', u, { from: Q1, to: Q2, actor: 'test' }), (err: unknown) => err instanceof SyncConflictError && err.code === 'moving');

  const v = newUuid();
  await seed(v, Q1);
  const q = quick.action('qg', v, { action: 'fresh' }, 'test');
  const t = await nextSent('quests_action', Q1);
  await ack(t);
  await assert.rejects(q, rejectsWith('timeout'));
  assert.equal((await opDoc(t.opId)).state, 'acked', 'an acked op cannot be cancelled');
  assert.match((await ledger.get('qg', v))?.lease?.holder ?? '', /^quests:/);
});

test('action: a parked op (waiting_player) is cancelled: 409 player_offline', async () => {
  const u = newUuid();
  await seed(u, Q1);
  const p = quests.action('qg', u, { action: 'fresh' }, 'test');
  const s = await nextSent('quests_action', Q1);
  await reply(s, 'waiting_player');
  await assert.rejects(p, rejectsWith('player_offline'));
  assert.equal((await opDoc(s.opId)).state, 'cancelled');
  assert.equal((await ledger.get('qg', u))?.lease, null);
});

// ── party candidates ─────────────────────────────────────────────────────────

test('party candidates: every other member at once; a member without a link is offline, one that fails is error', async () => {
  const u = newUuid();
  await seed(u, Q1);
  links.delete(Q3);
  try {
    const p = quests.partyCandidates('qg', u, 'test');
    const s = await nextSent('quests_party_candidates', Q2);
    assert.deepEqual(s.params, { group: 'qg', uuid: u });
    await reply(s, 'completed', { parties: [{ teamId: T2.toUpperCase(), name: 'Two', members: [{ uuid: u, name: 'Steve' }], done: 5 }, { name: 'no id' }, 'junk'] });
    const view = await p;
    assert.equal(view['partial'], true);
    assert.deepEqual(view['offline'], [Q3]);
    assert.deepEqual(view['instances'], [
      { serverId: Q2, instanceNumber: 2, label: 'Instance 2', status: 'ok' },
      { serverId: Q3, instanceNumber: 3, label: 'Instance 3', status: 'offline' },
    ]);
    assert.deepEqual(view['parties'], [
      { teamId: T2, name: 'Two', members: [{ uuid: u, name: 'Steve' }], done: 5, serverId: Q2, instanceNumber: 2, label: 'Instance 2', mergedInto: [] },
    ]);
    assert.equal(sentOf('quests_party_candidates', Q3).length, 0, 'nothing goes to a member without a link');
  } finally {
    links.set(Q3, { instanceKey: ik(Q3), grantedFeatures: GRANT, fp: FP });
  }

  const p = quests.partyCandidates('qg', u, 'test');
  const [s2, s3] = await Promise.all([nextSent('quests_party_candidates', Q2), nextSent('quests_party_candidates', Q3)]);
  await reply(s3, 'failed', undefined, 'unsupported_op');
  await reply(s2, 'completed', { parties: [] });
  const view = await p;
  assert.equal(view['partial'], true);
  const inst = view['instances'] as Array<Record<string, unknown>>;
  assert.equal(inst[0]!['status'], 'ok');
  assert.equal(inst[1]!['status'], 'error');
  assert.equal(inst[1]!['code'], 'not_ready');
  assert.deepEqual(view['offline'], [Q3], 'a member that did not answer counts as offline');
});

// ── party merge ──────────────────────────────────────────────────────────────

/**
 * What the mod does for `quests_export_party`: the record goes up as a `party_export` syncsnap,
 * stored before the op result. Answers the export result that names it.
 */
async function storeExport(teamId: string, body: unknown, serverId = Q2): Promise<{ result: Record<string, unknown>; gz: Buffer; snapshotId: string }> {
  const gz = gzipSync(Buffer.from(JSON.stringify(body)));
  const sha256 = createHash('sha256').update(gz).digest('hex');
  const { snapshot } = await snapshots.insert({
    group: 'qg',
    serverId,
    header: { kind: 'party_export', uuid: teamId, name: 'Two', group: 'qg', v: 0, sha256, gzLen: gz.length, blocked: [], links: [], worldData: [], playerData: [] },
    gz,
  });
  return { result: { sha256, gzLen: gz.length, teamId, members: [] }, gz, snapshotId: snapshot._id };
}

/** Answers the status, export and import ops of one party merge from Q2 into T1 on Q1. */
async function answerMerge(
  teamId: string,
  body: unknown,
  importResult: Record<string, unknown>,
): Promise<{ status: Sent; exp: Sent; imp: Sent; gz: Buffer; snapshotId: string; sha256: string }> {
  const status = await nextSent('quests_status', Q1);
  await reply(status, 'completed', partyBook(T1));
  const exp = await nextSent('quests_export_party', Q2);
  const stored = await storeExport(teamId, body);
  await reply(exp, 'completed', stored.result);
  const imp = await nextSent('quests_import_party', Q1);
  await reply(imp, 'completed', importResult);
  return { status, exp, imp, gz: stored.gz, snapshotId: stored.snapshotId, sha256: String(stored.result['sha256']) };
}

test('party merge: status, export, import in order; one merge per pair; later calls get 409 already_merged', async () => {
  const u = newUuid();
  await seed(u, Q1);
  const record = { teamId: T2, done: ['a', 'b'] };
  const p = quests.partyMerge('qg', u, { fromServer: Q2, teamId: T2.toUpperCase() }, 'test');
  const { exp, imp, gz, snapshotId, sha256 } = await answerMerge(T2, record, { ok: true, backupId: 'b-merge' });
  assert.deepEqual(exp.params, { group: 'qg', teamId: T2 });
  assert.equal(exp.target, null, 'an export names a team, no player');
  assert.deepEqual(imp.params, { group: 'qg', uuid: u, sha256, sourceServerId: Q2, sourceTeamId: T2 }, 'the wire params carry no record and no snapshotId');
  assert.deepEqual(imp.blob, gz, 'the export gz rides as the op blob');
  assert.deepEqual(JSON.parse(gunzipSync(imp.blob!).toString('utf8')), record);
  assert.equal((await opDoc(imp.opId)).params['snapshotId'], snapshotId, 'the stored op names the snapshot');
  const view = await p;
  assert.equal(view['ok'], true);
  assert.equal(view['backupId'], 'b-merge');
  const merge = view['merge'] as Record<string, unknown>;
  const id = questMergeId('qg', Q2, T2, Q1, T1);
  assert.equal(merge['id'], id);
  assert.equal(merge['state'], 'done');
  assert.equal(merge['backupId'], 'b-merge');
  const doc = await merges.get(id);
  assert.equal(doc?.exportOpId, exp.opId);
  assert.equal(doc?.importOpId, imp.opId);
  assert.equal((await ledger.get('qg', u))?.lease, null);

  for (let i = 0; i < 2; i++) {
    const again = quests.partyMerge('qg', u, { fromServer: Q2, teamId: T2 }, 'test');
    await reply(await nextSent('quests_status', Q1), 'completed', partyBook(T1));
    await assert.rejects(again, rejectsWith('already_merged'));
  }
  assert.equal(sentOf('quests_export_party').filter((s) => s.params['teamId'] === T2).length, 1, 'no second export');
  assert.equal((await ledger.get('qg', u))?.lease, null);

  const c = quests.partyCandidates('qg', u, 'test');
  await reply(await nextSent('quests_party_candidates', Q2), 'completed', { parties: [{ teamId: T2, name: 'Two', members: [], done: 2 }] });
  await reply(await nextSent('quests_party_candidates', Q3), 'completed', { parties: [] });
  const parties = (await c)['parties'] as Array<Record<string, unknown>>;
  assert.equal(parties.length, 1);
  assert.deepEqual(
    (parties[0]!['mergedInto'] as Array<Record<string, unknown>>).map((m) => [m['targetServerId'], m['targetTeamId']]),
    [[Q1, T1]],
  );
});

test('party merge: a failed export frees the pair; an import the mod refuses answers ok false; the retry merges', async () => {
  const u = newUuid();
  await seed(u, Q1);
  const T3 = '33333333-0000-4000-8000-000000000003';
  const id = questMergeId('qg', Q2, T3, Q1, T1);

  const p1 = quests.partyMerge('qg', u, { fromServer: Q2, teamId: T3 }, 'test');
  await reply(await nextSent('quests_status', Q1), 'completed', partyBook(T1));
  await reply(await nextSent('quests_export_party', Q2), 'failed', undefined, 'no_team');
  await assert.rejects(p1, rejectsWith('no_team'));
  assert.deepEqual([(await merges.get(id))?.state, (await merges.get(id))?.code], ['failed', 'no_team']);
  assert.equal((await ledger.get('qg', u))?.lease, null);

  const p2 = quests.partyMerge('qg', u, { fromServer: Q2, teamId: T3 }, 'test');
  await answerMerge(T3, { teamId: T3, done: [] }, { ok: false, code: 'not_owner' });
  const v2 = await p2;
  assert.equal(v2['ok'], false);
  assert.equal((v2['merge'] as Record<string, unknown>)['state'], 'failed');
  assert.equal((await merges.get(id))?.code, 'not_owner');

  const p3 = quests.partyMerge('qg', u, { fromServer: Q2, teamId: T3 }, 'test');
  await answerMerge(T3, { teamId: T3, done: ['z'] }, { ok: true, backupId: 'b-3' });
  const v3 = await p3;
  assert.equal((v3['merge'] as Record<string, unknown>)['state'], 'done');
  assert.equal((await merges.get(id))?.attempts, 3);
});

test('party merge refusals: same instance, not a member, frozen, fingerprint mismatch, not in a party, bad export', async () => {
  const u = newUuid();
  await seed(u, Q1);
  await assert.rejects(quests.partyMerge('qg', u, { fromServer: Q1, teamId: T2 }, 'test'), rejectsWith('same_instance'));
  await assert.rejects(quests.partyMerge('qg', u, { fromServer: OFF, teamId: T2 }, 'test'), rejectsWith('not_member'));

  await groups.upsert('qg', { frozen: true }, 'test');
  try {
    await assert.rejects(quests.partyMerge('qg', u, { fromServer: Q2, teamId: T2 }, 'test'), rejectsWith('frozen'));
  } finally {
    await groups.upsert('qg', { frozen: false }, 'test');
  }

  links.set(Q2, { instanceKey: ik(Q2), grantedFeatures: GRANT, fp: 'e'.repeat(64) });
  try {
    await assert.rejects(quests.partyMerge('qg', u, { fromServer: Q2, teamId: T2 }, 'test'), rejectsWith('fingerprint_mismatch'));
  } finally {
    links.set(Q2, { instanceKey: ik(Q2), grantedFeatures: GRANT, fp: FP });
  }

  links.delete(Q2);
  try {
    await assert.rejects(quests.partyMerge('qg', u, { fromServer: Q2, teamId: T2 }, 'test'), rejectsWith('source_offline'));
  } finally {
    links.set(Q2, { instanceKey: ik(Q2), grantedFeatures: GRANT, fp: FP });
  }

  const own = quests.partyMerge('qg', u, { fromServer: Q2, teamId: T1 }, 'test');
  await reply(await nextSent('quests_status', Q1), 'completed', partyBook(T1));
  await assert.rejects(own, rejectsWith('same_team'));

  const solo = quests.partyMerge('qg', u, { fromServer: Q2, teamId: T2 }, 'test');
  await reply(await nextSent('quests_status', Q1), 'completed', { book: { kind: 'player', teamId: u }, done: 0 });
  await assert.rejects(solo, rejectsWith('not_in_party'));
  assert.equal(await merges.get(questMergeId('qg', Q2, T2, Q1, u)), null, 'no pair was reserved');

  const T6 = '66666666-0000-4000-8000-000000000006';
  const bad = quests.partyMerge('qg', u, { fromServer: Q2, teamId: T6 }, 'test');
  await reply(await nextSent('quests_status', Q1), 'completed', partyBook(T1));
  await reply(await nextSent('quests_export_party', Q2), 'completed', { record: 'H4sIAAAA' });
  await assert.rejects(bad, rejectsWith('bad_export', 502), 'an inline record without a sha256');
  assert.equal((await merges.get(questMergeId('qg', Q2, T6, Q1, T1)))?.state, 'failed');
  assert.equal((await ledger.get('qg', u))?.lease, null);

  const lost = quests.partyMerge('qg', u, { fromServer: Q2, teamId: T6 }, 'test');
  await reply(await nextSent('quests_status', Q1), 'completed', partyBook(T1));
  await reply(await nextSent('quests_export_party', Q2), 'completed', { sha256: 'd'.repeat(64), gzLen: 10, teamId: T6, members: [] });
  await assert.rejects(lost, rejectsWith('bad_export', 502), 'no stored snapshot for that sha256');
  assert.equal(sentOf('quests_import_party').filter((s) => s.params['sourceTeamId'] === T6).length, 0, 'no import went out');
  assert.equal((await ledger.get('qg', u))?.lease, null);
});

test('party merge: an import with no result in time keeps the pair running and the lock; the next call settles it from the op', async () => {
  const u = newUuid();
  await seed(u, Q1);
  const T4 = '44444444-0000-4000-8000-000000000004';
  const id = questMergeId('qg', Q2, T4, Q1, T1);
  const p = quick.partyMerge('qg', u, { fromServer: Q2, teamId: T4 }, 'test');
  await reply(await nextSent('quests_status', Q1), 'completed', partyBook(T1));
  await reply(await nextSent('quests_export_party', Q2), 'completed', (await storeExport(T4, { teamId: T4 })).result);
  const imp = await nextSent('quests_import_party', Q1);
  await ack(imp);
  await assert.rejects(p, rejectsWith('timeout'));
  const doc = await merges.get(id);
  assert.equal(doc?.state, 'running');
  assert.equal(doc?.importOpId, imp.opId);
  assert.match((await ledger.get('qg', u))?.lease?.holder ?? '', /^quests:/, 'the lock stays');

  // The result comes late, and the lock lapses.
  await dispatcher.onOpRes(imp.instanceKey, { opId: imp.opId, phase: 'result', status: 'completed', result: { ok: true, backupId: 'late' } });
  await ledger.casUpdate({ _id: ledgerId('qg', u) }, { $set: { 'lease.until': new Date(Date.now() - 1) } });

  const again = quests.partyMerge('qg', u, { fromServer: Q2, teamId: T4 }, 'test');
  await reply(await nextSent('quests_status', Q1), 'completed', partyBook(T1));
  await assert.rejects(again, rejectsWith('already_merged'));
  const settled = await merges.get(id);
  assert.deepEqual([settled?.state, settled?.backupId], ['done', 'late']);
});

test('party merge: a running pair of an attempt that lost its lock and sent no import is failed and starts again', async () => {
  const u = newUuid();
  await seed(u, Q1);
  const T5 = '55555555-0000-4000-8000-000000000005';
  const id = questMergeId('qg', Q2, T5, Q1, T1);
  const now = new Date();
  const dead: SyncQuestMergeDoc = {
    _id: id,
    group: 'qg',
    uuid: u,
    name: 'Steve',
    sourceServerId: Q2,
    sourceTeamId: T5,
    targetServerId: Q1,
    targetTeamId: T1,
    state: 'running',
    runId: 'quests:dead',
    attempts: 1,
    exportOpId: null,
    importOpId: null,
    backupId: null,
    code: null,
    error: null,
    actor: 'test',
    startedAt: now,
    updatedAt: now,
    endedAt: null,
  };
  await db.collection<SyncQuestMergeDoc>('biforesting_sync_quest_merges').insertOne(dead);
  const p = quests.partyMerge('qg', u, { fromServer: Q2, teamId: T5 }, 'test');
  await answerMerge(T5, { teamId: T5 }, { ok: true, backupId: 'b-5' });
  const view = await p;
  assert.equal((view['merge'] as Record<string, unknown>)['state'], 'done');
  assert.equal((await merges.get(id))?.attempts, 2);
});

test('dispatch: a quests_import_party whose snapshot is not the export of its source team fails not_applied and sends nothing', async () => {
  const u = newUuid();
  const T7 = '77777777-0000-4000-8000-000000000007';
  const other = await storeExport(T2, { teamId: T2, done: ['x'] });
  const sha256 = String(other.result['sha256']);
  const before = sent.length;
  for (const params of [
    { group: 'qg', uuid: u, sha256, snapshotId: other.snapshotId, sourceServerId: Q2, sourceTeamId: T7 },
    { group: 'qg', uuid: u, sha256, snapshotId: other.snapshotId, sourceServerId: Q3, sourceTeamId: T2 },
    { group: 'qg', uuid: u, sha256: 'e'.repeat(64), snapshotId: other.snapshotId, sourceServerId: Q2, sourceTeamId: T2 },
    { group: 'qg', uuid: u, sha256, snapshotId: 'qg:gone', sourceServerId: Q2, sourceTeamId: T2 },
  ]) {
    const { op } = await store.create({
      instanceKey: ik(Q1),
      serverTag: 'qg',
      type: 'quests_import_party',
      params,
      target: { uuid: u, name: 'Steve' },
      dispatchTimeoutMs: 5_000,
      execTimeoutMs: 20_000,
      maxAttempts: 1,
      expiresInMs: 10_000,
      createdBy: 'test',
    });
    await dispatcher.onOpCreated(op);
    const done = await opDoc(op._id);
    assert.equal(done.state, 'failed', JSON.stringify(params));
    assert.equal(done.result?.code, 'not_applied');
  }
  assert.equal(sent.length, before, 'no op went down');
});
