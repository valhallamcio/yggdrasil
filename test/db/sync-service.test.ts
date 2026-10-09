import '../helpers/env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Db } from 'mongodb';

import { startTestMongo, type TestMongo } from '../helpers/mongo.ts';
import { eventBus } from '../../src/core/event-bus/index.ts';
import { SyncGroupsStore } from '../../src/plugins/biforesting-link/sync-groups-store.ts';
import { SyncLedgerStore } from '../../src/plugins/biforesting-link/sync-ledger-store.ts';
import { SyncSnapshotStore } from '../../src/plugins/biforesting-link/sync-snapshot-store.ts';
import { SyncShadowStore } from '../../src/plugins/biforesting-link/sync-shadow-store.ts';
import { SyncService, type SyncInstanceLink } from '../../src/plugins/biforesting-link/sync-service.ts';
import type { GroupMember } from '../../src/plugins/biforesting-link/server-resolver.ts';
import type { LinkIdentity, PresenceMsg, SyncSnapHeader } from '../../src/plugins/biforesting-link/types.ts';
import type { AppEventPayload } from '../../src/core/event-bus/events.ts';

/** Player sync S1 service: shadow ledger, snapshot intake, group status and shadow-move verdicts (spec 6.5). */

let mongo: TestMongo;
let db: Db;
let groups: SyncGroupsStore;
let ledger: SyncLedgerStore;
let snapshots: SyncSnapshotStore;
let service: SyncService;

const PLAYER_SYNC = 0x80000;
const FP = 'f'.repeat(64);
const AT = 1_760_000_000_000;

/** Fake directory: serverId → group, group → members. */
const memberships = new Map<string, { group: string; instanceNumber: number }>([
  ['e7575fc9', { group: 'evol', instanceNumber: 1 }],
  ['1ae705e3', { group: 'evol', instanceNumber: 2 }],
  ['0ffg0000', { group: 'offgrp', instanceNumber: 1 }],
  ['shadow01', { group: 'shgrp', instanceNumber: 1 }],
]);
/** Fake link port: live instances by serverId. */
const live = new Map<string, SyncInstanceLink>();

let seq = 0;
const uuid = (): string => `00000000-0000-4000-9000-${String(++seq).padStart(12, '0')}`;

function identity(serverId: string | null): LinkIdentity {
  return { linkServerId: serverId ?? 'evol', tag: 'evol', instanceKey: serverId ? `evol:${serverId}` : 'evol', name: null, serverId, serverOid: null, resolved: true };
}

function snapHeader(u: string, extra: Partial<SyncSnapHeader> = {}): SyncSnapHeader {
  return { kind: 'shadow', uuid: u, name: 'Steve', v: 0, sha256: 'b'.repeat(64), gzLen: 2, blocked: [], links: [], worldData: [], playerData: [], at: AT, ...extra };
}

before(async () => {
  mongo = await startTestMongo();
  db = mongo.client.db('ygg_sync_service_test');
  groups = new SyncGroupsStore(() => db);
  ledger = new SyncLedgerStore(() => db);
  snapshots = new SyncSnapshotStore(() => db, ledger);
  const shadow = new SyncShadowStore(() => db);
  service = new SyncService(
    { groups, ledger, snapshots, shadow },
    {
      groupOf: async (serverId) => memberships.get(serverId)?.group ?? null,
      groupMembers: async (group) =>
        [...memberships.entries()]
          .filter(([, m]) => m.group === group)
          .map(([serverId, m]): GroupMember => ({ serverId, instanceNumber: m.instanceNumber, name: serverId })),
    },
    { instance: async (serverId) => live.get(serverId) ?? null },
  );
  await groups.upsert('evol', { mode: 'shadow' }, 'test');
  await groups.upsert('shgrp', { mode: 'shadow' }, 'test');
});
after(async () => mongo.stop());

function presence(event: PresenceMsg['event'], players: PresenceMsg['online']): PresenceMsg {
  return event === 'snapshot' ? { event, player: null, online: players } : { event, player: players?.[0] ?? null, online: null };
}

// ── presence → ledger ────────────────────────────────────────────────────────

test('presence: mode off (no group doc) writes nothing', async () => {
  const u = uuid();
  await service.onPresence(identity('0ffg0000'), presence('join', [{ uuid: u, name: 'Off' }]));
  assert.equal(await ledger.get('offgrp', u), null);
});

test('presence: a session with no serverId, or a server in no group, writes nothing', async () => {
  const u = uuid();
  await service.onPresence(identity(null), presence('join', [{ uuid: u, name: 'X' }]));
  await service.onPresence(identity('nogroup1'), presence('join', [{ uuid: u, name: 'X' }]));
  assert.equal(await db.collection('biforesting_sync_players').countDocuments({ uuid: u }), 0);
});

test('presence: shadow join creates the doc from the stamp, quit only updates lastSeen', async () => {
  const u = uuid();
  await service.onPresence(identity('e7575fc9'), presence('join', [{ uuid: u, name: 'Steve', sync: { g: 'evol', v: 3, m: 'M3' } }]));
  const joined = await ledger.get('evol', u);
  assert.equal(joined?.owner, 'e7575fc9');
  assert.equal(joined?.version, 3);
  assert.equal(joined?.shadow, true);
  assert.deepEqual(joined?.lastSeen?.stamp, { g: 'evol', v: 3, m: 'M3' });

  await service.onPresence(identity('1ae705e3'), presence('quit', [{ uuid: u, name: 'Steve', sync: { g: 'evol', v: 99 } }]));
  const quit = await ledger.get('evol', u);
  assert.equal(quit?.owner, 'e7575fc9', 'S1 never moves the owner');
  assert.equal(quit?.lastSeen?.serverId, '1ae705e3');
  assert.equal(quit?.lastSeen?.event, 'quit');
  assert.equal(quit?.lastSeen?.stamp, null, 'a quit carries no stamp');
});

test('presence: snapshot entries create docs; bad entries and bad stamps are skipped', async () => {
  const good = uuid();
  const msg = {
    event: 'snapshot',
    player: null,
    online: [{ uuid: good, name: 'Good', sync: { g: 'evol', v: 'x' } }, { uuid: 'not-a-uuid', name: 'Bad' }, null],
  } as unknown as PresenceMsg;
  await service.onPresence(identity('e7575fc9'), msg);
  const doc = await ledger.get('evol', good);
  assert.equal(doc?.version, 0, 'a malformed stamp counts as no stamp');
  assert.equal(doc?.lastSeen?.stamp, null);
  assert.equal(doc?.lastSeen?.event, 'snapshot');
  assert.equal(await db.collection('biforesting_sync_players').countDocuments({ name: 'Bad' }), 0);
});

// ── syncsnap intake ──────────────────────────────────────────────────────────

test('syncsnap: stored under the sender serverId and its group, with an event', async () => {
  const u = uuid();
  const events: Array<AppEventPayload<'biforesting.sync.snapshot'>> = [];
  const listener = (p: AppEventPayload<'biforesting.sync.snapshot'>): void => {
    events.push(p);
  };
  eventBus.on('biforesting.sync.snapshot', listener);
  try {
    await service.onSyncSnap(identity('e7575fc9'), { header: snapHeader(u, { blocked: [{ where: 'Inventory', slot: '1', id: 'a:b', reason: 'block' }] }), gz: Buffer.from([7, 7]) });
    await service.onSyncSnap(identity('e7575fc9'), { header: snapHeader(u), gz: Buffer.from([8, 8]) });
  } finally {
    eventBus.off('biforesting.sync.snapshot', listener);
  }
  const list = await snapshots.list('evol', u);
  assert.equal(list.length, 1, 'the replay of the same key keeps the first');
  assert.equal(list[0]!.serverId, 'e7575fc9');
  assert.equal(list[0]!.group, 'evol');
  assert.equal(events.length, 2);
  assert.equal(events[0]!.snapshotId, `evol:${u}:0:shadow:e7575fc9:${AT}`);
  assert.equal(events[0]!.duplicate, false);
  assert.equal(events[0]!.blocked.length, 1);
  assert.equal(events[1]!.duplicate, true);
  assert.equal('gz' in events[0]!, false, 'the event carries no blob');
});

test('syncsnap: dropped for mode off (shadow), another group, or a sender in no group', async () => {
  const u = uuid();
  await service.onSyncSnap(identity('0ffg0000'), { header: snapHeader(u), gz: Buffer.from([1]) });
  await service.onSyncSnap(identity('e7575fc9'), { header: snapHeader(u, { kind: 'release', group: 'other', moveId: 'M' }), gz: Buffer.from([1]) });
  await service.onSyncSnap(identity('nogroup1'), { header: snapHeader(u), gz: Buffer.from([1]) });
  await service.onSyncSnap(identity(null), { header: snapHeader(u), gz: Buffer.from([1]) });
  assert.equal(await db.collection('biforesting_sync_snapshots').countDocuments({ uuid: u }), 0);
});

// ── group status ─────────────────────────────────────────────────────────────

test('group status: members with live facts, fpMatch only when all live members share one fp', async () => {
  live.clear();
  live.set('e7575fc9', { instanceKey: 'evol:e7575fc9', grantedFeatures: 0x400 | PLAYER_SYNC, fp: FP });
  live.set('1ae705e3', { instanceKey: 'evol:1ae705e3', grantedFeatures: 0x400 | PLAYER_SYNC, fp: FP });
  const status = await service.groupStatus('evol');
  assert.equal(status.group, 'evol');
  assert.equal(status.mode, 'shadow');
  assert.deepEqual(status.instances.map((i) => [i.serverId, i.instanceNumber, i.live, i.fpMatch]), [
    ['e7575fc9', 1, true, true],
    ['1ae705e3', 2, true, true],
  ]);
  assert.deepEqual(status.instances[0]!.features, ['ops', 'player_sync']);
  assert.ok(status.counts.online >= 1);

  live.set('1ae705e3', { instanceKey: 'evol:1ae705e3', grantedFeatures: PLAYER_SYNC, fp: 'e'.repeat(64) });
  assert.deepEqual((await service.groupStatus('evol')).instances.map((i) => i.fpMatch), [false, false]);

  live.delete('1ae705e3');
  const one = await service.groupStatus('evol');
  assert.deepEqual(one.instances.map((i) => [i.live, i.fpMatch, i.fp]), [[true, true, FP], [false, false, null]]);
});

// ── shadow-move verdicts ─────────────────────────────────────────────────────

test('shadow-move: ok when both live with player_sync, equal fp, not frozen, clean newest snapshot', async () => {
  const u = uuid();
  live.clear();
  live.set('e7575fc9', { instanceKey: 'evol:e7575fc9', grantedFeatures: PLAYER_SYNC, fp: FP });
  live.set('1ae705e3', { instanceKey: 'evol:1ae705e3', grantedFeatures: PLAYER_SYNC, fp: FP });
  await service.onSyncSnap(identity('e7575fc9'), { header: snapHeader(u), gz: Buffer.from([1]) });

  const verdict = await service.shadowMove('evol', u, 'e7575fc9', '1ae705e3');
  assert.deepEqual(verdict, { verdict: 'ok', reasons: [] });
  const stored = await db.collection('biforesting_sync_shadow').findOne({ uuid: u });
  assert.equal(stored?.['verdict'], 'ok');
  assert.ok(stored?.['expireAt'] instanceof Date);
});

test('shadow-move: every failed check is a stable reason code', async () => {
  const u = uuid();
  live.clear();
  live.set('e7575fc9', { instanceKey: 'evol:e7575fc9', grantedFeatures: 0x400, fp: FP });

  const noSnap = await service.shadowMove('evol', u, 'e7575fc9', '1ae705e3');
  assert.equal(noSnap.verdict, 'blocked');
  assert.deepEqual(noSnap.reasons, [
    { code: 'feature_off', serverId: 'e7575fc9' },
    { code: 'no_link', serverId: '1ae705e3' },
    { code: 'no_snapshot' },
  ]);

  const stranger = await service.shadowMove('evol', u, 'e7575fc9', 'shadow01');
  assert.ok(stranger.reasons.some((r) => r.code === 'not_member' && r.serverId === 'shadow01'));

  live.set('e7575fc9', { instanceKey: 'evol:e7575fc9', grantedFeatures: PLAYER_SYNC, fp: FP });
  live.set('1ae705e3', { instanceKey: 'evol:1ae705e3', grantedFeatures: PLAYER_SYNC, fp: null });
  const blocked = [{ where: 'Inventory', slot: '5', id: 'dankstorage:dank_3', reason: 'block' }];
  await service.onSyncSnap(identity('1ae705e3'), { header: snapHeader(u, { blocked }), gz: Buffer.from([2]) });
  await groups.upsert('evol', { frozen: true, freezeReason: 'pack update' }, 'test');
  try {
    const r = await service.shadowMove('evol', u, 'e7575fc9', '1ae705e3');
    assert.deepEqual(r.reasons, [
      { code: 'fingerprint_mismatch', detail: `e7575fc9=${FP} 1ae705e3=none` },
      { code: 'frozen', detail: 'pack update' },
      { code: 'blocked_items', snapshotId: `evol:${u}:0:shadow:1ae705e3:${AT}`, blocked },
    ]);
  } finally {
    await groups.upsert('evol', { frozen: false, freezeReason: null }, 'test');
  }
  assert.equal(await db.collection('biforesting_sync_shadow').countDocuments({ uuid: u }), 3, 'each verdict is stored');
});
