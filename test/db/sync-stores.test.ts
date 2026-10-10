import '../helpers/env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Db } from 'mongodb';

import { startTestMongo, type TestMongo } from '../helpers/mongo.ts';
import { SyncGroupsStore, SYNC_GROUP_DEFAULTS } from '../../src/plugins/biforesting-link/sync-groups-store.ts';
import { SyncLedgerStore, ledgerId } from '../../src/plugins/biforesting-link/sync-ledger-store.ts';
import { SyncSnapshotStore, SNAPSHOT_RETENTION } from '../../src/plugins/biforesting-link/sync-snapshot-store.ts';
import { SyncShadowStore, SHADOW_TTL_MS } from '../../src/plugins/biforesting-link/sync-shadow-store.ts';
import type { SyncSnapHeader, SyncSnapKind } from '../../src/plugins/biforesting-link/types.ts';

/** Player sync stores (player-sync spec 5) over mem-mongo. */

let mongo: TestMongo;
let db: Db;
let groups: SyncGroupsStore;
let ledger: SyncLedgerStore;
let snapshots: SyncSnapshotStore;
let shadow: SyncShadowStore;

const DAY = 24 * 3600_000;
let seq = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

before(async () => {
  mongo = await startTestMongo();
  db = mongo.client.db('ygg_sync_stores_test');
  groups = new SyncGroupsStore(() => db);
  ledger = new SyncLedgerStore(() => db);
  snapshots = new SyncSnapshotStore(() => db, ledger);
  shadow = new SyncShadowStore(() => db);
  for (const s of [groups, ledger, snapshots, shadow]) await s.ensureIndexes();
});
after(async () => mongo.stop());

function header(u: string, kind: SyncSnapKind, v: number, extra: Partial<SyncSnapHeader> = {}): SyncSnapHeader {
  return {
    kind,
    uuid: u,
    name: 'Steve',
    v,
    sha256: 'a'.repeat(64),
    gzLen: 3,
    blocked: [],
    links: [],
    worldData: [],
    playerData: [],
    ...extra,
  };
}

// ── groups ───────────────────────────────────────────────────────────────────

test('groups: an absent group reads as the defaults (mode off) and is not created', async () => {
  const doc = await groups.get('nogroup');
  assert.deepEqual(doc, { _id: 'nogroup', ...SYNC_GROUP_DEFAULTS });
  assert.equal(await db.collection('biforesting_sync_groups').countDocuments({ _id: 'nogroup' } as never), 0);
});

test('groups: upsert seeds the defaults, a later upsert keeps earlier fields', async () => {
  const first = await groups.upsert('evol', { mode: 'shadow' }, 'alice');
  assert.equal(first.mode, 'shadow');
  assert.equal(first.cooldownMs, 600_000);
  assert.equal(first.holdMs, 10_000);
  assert.equal(first.frozen, false);
  assert.equal(first.freezeReason, null);
  assert.equal(first.updatedBy, 'alice');

  const second = await groups.upsert('evol', { frozen: true, freezeReason: 'pack update' }, 'bob');
  assert.equal(second.mode, 'shadow', 'mode survives a freeze-only update');
  assert.equal(second.frozen, true);
  assert.equal(second.freezeReason, 'pack update');
  assert.equal(second.updatedBy, 'bob');
  assert.deepEqual(await groups.get('evol'), second);
});

// ── ledger ───────────────────────────────────────────────────────────────────

test('ledger: a shadow join with no doc creates it owned by the server at the stamp version', async () => {
  const u = uuid();
  const doc = await ledger.upsertFromPresence('evol', u.toUpperCase(), 'Steve', 'srv-a', 'join', { g: 'evol', v: 4 }, 'shadow');
  assert.ok(doc);
  assert.equal(doc._id, ledgerId('evol', u));
  assert.equal(doc.uuid, u, 'uuid stored lowercase');
  assert.equal(doc.owner, 'srv-a');
  assert.equal(doc.version, 4);
  assert.equal(doc.state, 'online');
  assert.equal(doc.shadow, true);
  assert.deepEqual(doc.disowned, []);
  assert.equal(doc.move, null);
  assert.equal(doc.lease, null);
  assert.deepEqual(doc.lastSeen?.stamp, { g: 'evol', v: 4 });
  assert.equal(doc.lastSeen?.event, 'join');
});

test('ledger: no stamp or a negative stamp creates version 0; live mode creates shadow:false', async () => {
  const a = await ledger.upsertFromPresence('evol', uuid(), 'A', 'srv-a', 'snapshot', null, 'shadow');
  assert.equal(a?.version, 0);
  const b = await ledger.upsertFromPresence('evol', uuid(), 'B', 'srv-a', 'join', { g: 'evol', v: -3 }, 'shadow');
  assert.equal(b?.version, 0);
  const c = await ledger.upsertFromPresence('evol', uuid(), 'C', 'srv-a', 'join', null, 'live');
  assert.equal(c?.shadow, false);
});

test('ledger: presence never changes the owner, version or state of an existing doc', async () => {
  const u = uuid();
  await ledger.upsertFromPresence('evol', u, 'Steve', 'srv-a', 'join', { g: 'evol', v: 2 }, 'shadow');
  const later = await ledger.upsertFromPresence('evol', u, 'Steve2', 'srv-b', 'join', { g: 'evol', v: 9 }, 'shadow');
  assert.equal(later?.owner, 'srv-a');
  assert.equal(later?.version, 2);
  assert.equal(later?.name, 'Steve2', 'name follows the latest presence');
  assert.equal(later?.lastSeen?.serverId, 'srv-b');
  assert.deepEqual(later?.lastSeen?.stamp, { g: 'evol', v: 9 });
});

test('ledger: a quit updates lastSeen, and a quit with no doc creates nothing', async () => {
  const u = uuid();
  assert.equal(await ledger.upsertFromPresence('evol', u, 'Ghost', 'srv-a', 'quit', null, 'shadow'), null);
  assert.equal(await ledger.get('evol', u), null);

  await ledger.upsertFromPresence('evol', u, 'Ghost', 'srv-a', 'join', { g: 'evol', v: 1 }, 'shadow');
  const quit = await ledger.upsertFromPresence('evol', u, 'Ghost', 'srv-a', 'quit', null, 'shadow');
  assert.equal(quit?.lastSeen?.event, 'quit');
  assert.equal(quit?.lastSeen?.stamp, null);
  assert.equal(quit?.owner, 'srv-a');
});

test('ledger: concurrent first joins from two servers end with one doc and one owner', async () => {
  const u = uuid();
  const [x, y] = await Promise.all([
    ledger.upsertFromPresence('evol', u, 'Twin', 'srv-a', 'join', null, 'shadow'),
    ledger.upsertFromPresence('evol', u, 'Twin', 'srv-b', 'join', null, 'shadow'),
  ]);
  assert.equal(x?.owner, y?.owner);
  assert.equal(await db.collection('biforesting_sync_players').countDocuments({ _id: ledgerId('evol', u) } as never), 1);
});

test('ledger: casUpdate guards on state, move id and lease', async () => {
  const u = uuid();
  const id = ledgerId('evol', u);
  await ledger.upsertFromPresence('evol', u, 'Cas', 'srv-a', 'join', null, 'shadow');
  const now = new Date();
  const move = { id: 'M1', from: 'srv-a', to: 'srv-b', step: 'prepare', startedAt: now, updatedAt: now };

  assert.equal(await ledger.casUpdate({ _id: id, state: 'moving' }, { $set: { owner: 'x' } }), null, 'wrong state');
  assert.equal(await ledger.casUpdate({ _id: id, moveId: 'M0' }, { $set: { owner: 'x' } }), null, 'no move M0');

  const started = await ledger.casUpdate(
    { _id: id, state: ['online'], moveId: null, lease: { holder: 'p1', now } },
    { $set: { state: 'moving', move, lease: { holder: 'p1', until: new Date(now.getTime() + 30_000) } } },
  );
  assert.equal(started?.state, 'moving');
  assert.ok(started && started.updatedAt.getTime() >= now.getTime(), 'updatedAt set');

  assert.equal(
    await ledger.casUpdate({ _id: id, moveId: 'M1', lease: { holder: 'p2', now } }, { $set: { 'move.step': 'release' } }),
    null,
    'another holder with a live lease loses',
  );
  const lapsed = await ledger.casUpdate(
    { _id: id, moveId: 'M1', lease: { holder: 'p2', now: new Date(now.getTime() + 60_000) } },
    { $set: { 'move.step': 'release' } },
  );
  assert.equal(lapsed?.move?.step, 'release', 'a lapsed lease can be taken');
  const own = await ledger.casUpdate({ _id: id, state: 'moving', moveId: 'M1', lease: { holder: 'p1', now } }, { $set: { version: 1 } });
  assert.equal(own?.version, 1, 'the holder passes');
});

test('ledger: countByState counts one group only', async () => {
  await ledger.upsertFromPresence('countgrp', uuid(), 'a', 'srv-a', 'join', null, 'shadow');
  await ledger.upsertFromPresence('countgrp', uuid(), 'b', 'srv-a', 'join', null, 'shadow');
  assert.deepEqual(await ledger.countByState('countgrp'), { online: 2, moving: 0, applying: 0, stuck: 0 });
});

test('ledger: indexes match the spec', async () => {
  const idx = await db.collection('biforesting_sync_players').indexes();
  const keys = idx.map((i) => JSON.stringify(i.key));
  assert.ok(keys.includes(JSON.stringify({ group: 1, state: 1 })));
  assert.ok(keys.includes(JSON.stringify({ state: 1, 'lease.until': 1 })));
  const move = idx.find((i) => JSON.stringify(i.key) === JSON.stringify({ 'move.id': 1 }));
  assert.equal(move?.sparse, true);
});

// ── snapshots ────────────────────────────────────────────────────────────────

test('snapshots: insert keys by group, uuid, v, kind and serverId; list has no blob, get has it', async () => {
  const u = uuid();
  const { snapshot, duplicate } = await snapshots.insert({ group: 'evol', serverId: 'srv-a', header: header(u, 'shadow', 0, { at: 1_760_000_000_000 }), gz: Buffer.from([1, 2, 3]) });
  assert.equal(duplicate, false);
  assert.equal(snapshot._id, `evol:${u}:0:shadow:srv-a:1760000000000`);
  assert.equal(snapshot.gzLen, 3);
  assert.equal('gz' in snapshot, false);

  const list = await snapshots.list('evol', u);
  assert.equal(list.length, 1);
  assert.equal((list[0] as unknown as Record<string, unknown>)['gz'], undefined, 'list never ships blobs');

  const one = await snapshots.get(snapshot._id);
  assert.deepEqual([...Buffer.from(one!.gz.buffer)], [1, 2, 3]);
});

test('snapshots: a replay of the same _id keeps the first doc; another move or sha256 at the same v gets its own doc', async () => {
  const u = uuid();
  const first = await snapshots.insert({ group: 'evol', serverId: 'srv-a', header: header(u, 'release', 3, { moveId: 'first' }), gz: Buffer.from([1]) });
  const again = await snapshots.insert({ group: 'evol', serverId: 'srv-a', header: header(u, 'release', 3, { moveId: 'first', name: 'Replay' }), gz: Buffer.from([2]) });
  assert.equal(again.duplicate, true);
  assert.equal(again.snapshot._id, first.snapshot._id);
  assert.equal(again.snapshot.name, 'Steve', 'the first doc stays');
  assert.equal('gz' in again.snapshot, false);

  const otherMove = await snapshots.insert({ group: 'evol', serverId: 'srv-a', header: header(u, 'release', 3, { moveId: 'second' }), gz: Buffer.from([3]) });
  const otherSha = await snapshots.insert({ group: 'evol', serverId: 'srv-a', header: header(u, 'release', 3, { moveId: 'first', sha256: 'b'.repeat(64) }), gz: Buffer.from([4]) });
  assert.deepEqual([otherMove.duplicate, otherSha.duplicate], [false, false]);
  assert.deepEqual(
    [first, otherMove, otherSha].map((r) => r.snapshot._id),
    [`evol:${u}:3:release:srv-a:first:aaaaaaaaaaaa`, `evol:${u}:3:release:srv-a:second:aaaaaaaaaaaa`, `evol:${u}:3:release:srv-a:first:bbbbbbbbbbbb`],
  );
  assert.equal((await snapshots.list('evol', u)).length, 3);
});

test('snapshots: shadow keeps a ring of 5 with a 30-day expireAt', async () => {
  const u = uuid();
  for (let v = 1; v <= 7; v++) {
    await snapshots.insert({ group: 'evol', serverId: 'srv-a', header: header(u, 'shadow', v), gz: Buffer.from([v]) });
  }
  const list = await snapshots.list('evol', u, 'shadow');
  assert.deepEqual(list.map((s) => s.v), [7, 6, 5, 4, 3]);
  const ttl = list[0]!.expireAt!.getTime() - list[0]!.createdAt.getTime();
  assert.equal(ttl, SNAPSHOT_RETENTION.shadow.ttlMs);
  assert.equal(ttl, 30 * DAY);
  assert.equal((await snapshots.newest('evol', u, 'shadow'))?.v, 7);
});

test('snapshots: shadow snapshots at v 0 key by their time, so the ring fills; the same time is a replay', async () => {
  const u = uuid();
  for (let i = 0; i < 7; i++) {
    await snapshots.insert({ group: 'evol', serverId: 'srv-a', header: header(u, 'shadow', 0, { at: 1_760_000_000_000 + i }), gz: Buffer.from([i]) });
  }
  const again = await snapshots.insert({ group: 'evol', serverId: 'srv-a', header: header(u, 'shadow', 0, { at: 1_760_000_000_006 }), gz: Buffer.from([9]) });
  assert.equal(again.duplicate, true);
  const list = await snapshots.list('evol', u, 'shadow');
  assert.equal(list.length, SNAPSHOT_RETENTION.shadow.keep);
  assert.ok(list.every((s) => s.v === 0));
  assert.equal(new Set(list.map((s) => s._id)).size, 5);

  // No header time: the insert time keys it. A release key takes the move and the sha256, never a time.
  const noAt = await snapshots.insert({ group: 'evol', serverId: 'srv-b', header: header(u, 'shadow', 0), gz: Buffer.from([1]) });
  assert.match(noAt.snapshot._id, new RegExp(`^evol:${u}:0:shadow:srv-b:\\d{13}$`));
  const rel = await snapshots.insert({ group: 'evol', serverId: 'srv-b', header: header(u, 'release', 1, { moveId: 'm', at: 5 }), gz: Buffer.from([1]) });
  assert.equal(rel.snapshot._id, `evol:${u}:1:release:srv-b:m:aaaaaaaaaaaa`);
});

test('groups: get serves a cached doc for 5 s; an upsert through the store replaces it at once', async () => {
  let clock = 1_000_000;
  const cached = new SyncGroupsStore(() => db, () => clock);
  await cached.upsert('cachegrp', { mode: 'shadow' }, 'test');
  assert.equal((await cached.get('cachegrp')).mode, 'shadow');
  await db.collection('biforesting_sync_groups').updateOne({ _id: 'cachegrp' } as never, { $set: { mode: 'live' } });
  assert.equal((await cached.get('cachegrp')).mode, 'shadow', 'served from memory');
  clock += 5_001;
  assert.equal((await cached.get('cachegrp')).mode, 'live', 'read again after 5 s');
  await cached.upsert('cachegrp', { mode: 'off' }, 'test');
  assert.equal((await cached.get('cachegrp')).mode, 'off', 'an upsert replaces the cached doc');
  const copy = await cached.get('cachegrp');
  copy.mode = 'live';
  assert.equal((await cached.get('cachegrp')).mode, 'off', 'callers get a copy');
});

test('snapshots: pre_sync keeps every one younger than 30 days, with a 180-day expireAt; rings are per kind', async () => {
  const u = uuid();
  await snapshots.insert({ group: 'evol', serverId: 'srv-a', header: header(u, 'shadow', 0), gz: Buffer.from([0]) });
  for (let v = 1; v <= 12; v++) {
    await snapshots.insert({ group: 'evol', serverId: 'srv-b', header: header(u, 'pre_sync', v, { moveId: `m${v}` }), gz: Buffer.from([v]) });
  }
  const pre = await snapshots.list('evol', u, 'pre_sync');
  assert.equal(pre.length, 12, 'none is older than 30 days');
  assert.equal(pre[0]!.expireAt!.getTime() - pre[0]!.createdAt.getTime(), 180 * DAY);
  assert.equal((await snapshots.list('evol', u, 'shadow')).length, 1, 'the shadow ring is untouched');

  // Age the 4 oldest past 30 days. The next insert trims the aged ones beyond the newest 10.
  const col = db.collection('biforesting_sync_snapshots');
  const old = new Date(Date.now() - 31 * DAY);
  for (const s of pre.slice(-4)) await col.updateOne({ _id: s._id } as never, { $set: { createdAt: old } });
  await snapshots.insert({ group: 'evol', serverId: 'srv-b', header: header(u, 'pre_sync', 13, { moveId: 'm13' }), gz: Buffer.from([13]) });
  const after = await snapshots.list('evol', u, 'pre_sync');
  assert.deepEqual(after.map((s) => s.v), [13, 12, 11, 10, 9, 8, 7, 6, 5, 4], 'the newest 10 stay, aged ones beyond them go');
});

test('snapshots: pre_action keys on the backupId, keeps 30 days and at most 200', async () => {
  const u = uuid();
  const h = header(u, 'pre_action', 3, { group: 'evol', action: 'fresh', backupId: '20261010T193000Z-fresh', at: 1_760_000_000_000 });
  const first = await snapshots.insert({ group: 'evol', serverId: 'srv-a', header: h, gz: Buffer.from([1]) });
  assert.equal(first.snapshot._id, `evol:${u}:3:pre_action:srv-a:20261010T193000Z-fresh:${'a'.repeat(12)}`);
  assert.equal(first.snapshot.expireAt!.getTime() - first.snapshot.createdAt.getTime(), 180 * DAY);
  assert.equal((await snapshots.insert({ group: 'evol', serverId: 'srv-a', header: h, gz: Buffer.from([1]) })).duplicate, true);
  const noBackup = await snapshots.insert({ group: 'evol', serverId: 'srv-a', header: header(u, 'pre_action', 3, { at: 1_760_000_000_001 }), gz: Buffer.from([2]) });
  assert.equal(noBackup.snapshot._id, `evol:${u}:3:pre_action:srv-a:1760000000001:${'a'.repeat(12)}`, 'no backupId: the header time');

  assert.equal(SNAPSHOT_RETENTION.pre_action.max, 200);
  for (let i = 0; i < 200; i++) {
    await snapshots.insert({ group: 'evol', serverId: 'srv-a', header: header(u, 'pre_action', 3, { backupId: `b-${i}` }), gz: Buffer.from([i % 256]) });
  }
  const all = await snapshots.list('evol', u, 'pre_action');
  assert.equal(all.length, 200, 'the cap holds even inside 30 days');
  assert.equal(all[0]!.header.backupId, 'b-199');
});

test('snapshots: party_export keys on team, source and sha256, lives one day, and findPartyExport finds it', async () => {
  const team = uuid();
  const sha = (c: string): string => c.repeat(64);
  const h = header(team, 'party_export', 0, { name: 'Club', group: 'evol', sha256: sha('b'), at: 1_760_000_000_000 });
  const first = await snapshots.insert({ group: 'evol', serverId: 'srv-b', header: h, gz: Buffer.from([7, 7]) });
  assert.equal(first.snapshot._id, `evol:${team}:0:party_export:srv-b:${'b'.repeat(12)}`);
  assert.equal(first.snapshot.expireAt!.getTime() - first.snapshot.createdAt.getTime(), DAY);
  const again = await snapshots.insert({ group: 'evol', serverId: 'srv-b', header: { ...h, at: 1_760_000_000_500 }, gz: Buffer.from([7, 7]) });
  assert.equal(again.duplicate, true, 'the same book exported again is a replay');

  const found = await snapshots.findPartyExport('evol', 'srv-b', team.toUpperCase(), sha('B'));
  assert.equal(found?._id, first.snapshot._id);
  assert.equal((found as unknown as Record<string, unknown>)['gz'], undefined, 'no blob');
  assert.equal(await snapshots.findPartyExport('evol', 'srv-a', team, sha('b')), null, 'another source');
  assert.equal(await snapshots.findPartyExport('evol', 'srv-b', team, sha('c')), null, 'another sha256');
  assert.equal(await snapshots.findPartyExport('other', 'srv-b', team, sha('b')), null, 'another group');

  for (let i = 0; i < 12; i++) {
    await snapshots.insert({ group: 'evol', serverId: 'srv-b', header: { ...h, sha256: (i + 10).toString(16).padEnd(64, '0') }, gz: Buffer.from([i]) });
  }
  assert.equal((await snapshots.list('evol', team, 'party_export')).length, SNAPSHOT_RETENTION.party_export.keep);
});

test('snapshots: release keeps 10, never the one at the ledger version, and has no expireAt', async () => {
  const u = uuid();
  const id = ledgerId('evol', u);
  await ledger.upsertFromPresence('evol', u, 'Rel', 'srv-a', 'join', null, 'shadow');
  await ledger.casUpdate({ _id: id }, { $set: { version: 1 } });
  for (let v = 1; v <= 12; v++) {
    await snapshots.insert({ group: 'evol', serverId: 'srv-a', header: header(u, 'release', v, { moveId: `m${v}` }), gz: Buffer.from([v]) });
  }
  const rel = await snapshots.list('evol', u, 'release');
  assert.deepEqual(rel.map((s) => s.v), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 1], 'v1 survives at the ledger version');
  assert.equal(rel[0]!.expireAt, undefined);
});

test('snapshots: indexes include the expireAt TTL', async () => {
  const idx = await db.collection('biforesting_sync_snapshots').indexes();
  const ttl = idx.find((i) => JSON.stringify(i.key) === JSON.stringify({ expireAt: 1 }));
  assert.equal(ttl?.expireAfterSeconds, 0);
});

// ── shadow verdicts ──────────────────────────────────────────────────────────

test('shadow: a stored verdict expires 30 days after it was made', async () => {
  const at = new Date();
  const doc = await shadow.insert({ group: 'evol', uuid: uuid(), from: 'srv-a', to: 'srv-b', at, verdict: 'blocked', reasons: [{ code: 'no_snapshot' }] });
  assert.equal(doc.expireAt.getTime() - at.getTime(), SHADOW_TTL_MS);
  assert.equal(await db.collection('biforesting_sync_shadow').countDocuments({ uuid: doc.uuid }), 1);
  const idx = await db.collection('biforesting_sync_shadow').indexes();
  assert.equal(idx.find((i) => JSON.stringify(i.key) === JSON.stringify({ expireAt: 1 }))?.expireAfterSeconds, 0);
});
