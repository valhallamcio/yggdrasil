import './helpers/env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { Writer } from '../src/plugins/biforesting-link/frame-codec.ts';
import {
  decodePresence,
  decodeRegister,
  decodeSyncSnap,
  encodeJsonPayload,
  SYNCSNAP_MAX_GZ_BYTES,
} from '../src/plugins/biforesting-link/decoders.ts';
import { FEATURE_BITS, featureNamesForMask, maskForFeatures } from '../src/plugins/biforesting-link/policy-store.ts';

/** Player sync S1 wire: policy names, register tail, presence stamp, syncsnap (player-sync spec 2, 3.2-3.4). */

const UUID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';
const SYNC = { fp: 'ab'.repeat(32), dv: 4790, mods: 312, items: 41829, cfg: 'cd'.repeat(32) };

function registerV2(tail?: (w: Writer) => void): Buffer {
  const w = new Writer()
    .varInt(2)
    .utf('e7575fc9')
    .utf('Evolution 1')
    .varInt(0x80c10)
    .utf('node-1')
    .utf('10.0.0.5:25565')
    .long(42n)
    .varInt(2);
  tail?.(w);
  return w.build();
}

const BASE_REGISTER = {
  serverId: 'e7575fc9',
  friendlyHint: 'Evolution 1',
  capabilities: 0x80c10,
  node: 'node-1',
  gameAddr: '10.0.0.5:25565',
  bootNonce: '42',
  linkProtocolVersion: 2,
};

function decodeWithReasons(payload: Buffer): { reg: ReturnType<typeof decodeRegister>; reasons: string[] } {
  const reasons: string[] = [];
  const reg = decodeRegister(payload, (r) => reasons.push(r));
  return { reg, reasons };
}

test('policy bits: player_sync is 0x80000 and shutdown_guard 0x100000', () => {
  assert.equal(FEATURE_BITS['player_sync'], 0x80000);
  assert.equal(FEATURE_BITS['shutdown_guard'], 0x100000);
  assert.equal(maskForFeatures(['player_sync', 'shutdown_guard']), 0x180000);
  assert.deepEqual(featureNamesForMask(0x180400), ['ops', 'player_sync', 'shutdown_guard']);
});

test('register: v2 with no tail decodes exactly as before, with no sync key', () => {
  const { reg, reasons } = decodeWithReasons(registerV2());
  assert.deepEqual(reg, BASE_REGISTER);
  assert.equal('sync' in reg, false);
  assert.deepEqual(reasons, []);
});

test('register: v1 never reads a tail', () => {
  const payload = new Writer().varInt(1).utf('s').utf('h').varInt(0x10).utf('n').utf('a:1').long(7n).build();
  const { reg, reasons } = decodeWithReasons(payload);
  assert.equal(reg.linkProtocolVersion, 1);
  assert.equal('sync' in reg, false);
  assert.deepEqual(reasons, []);
});

test('register: a sync tail lands in RegisterInfo.sync, later bytes are ignored', () => {
  const { reg, reasons } = decodeWithReasons(registerV2((w) => w.utf(JSON.stringify({ ...SYNC, extra: 1 })).varInt(99)));
  assert.deepEqual(reg, { ...BASE_REGISTER, sync: SYNC });
  assert.deepEqual(reasons, []);
});

test('register: a tail with bad JSON leaves sync undefined and reports, the register still decodes', () => {
  const { reg, reasons } = decodeWithReasons(registerV2((w) => w.utf('{"fp": nope')));
  assert.deepEqual(reg, BASE_REGISTER);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0]!, /unreadable sync tail/);
});

test('register: a truncated tail leaves sync undefined and reports', () => {
  const full = registerV2((w) => w.utf(JSON.stringify(SYNC)));
  const { reg, reasons } = decodeWithReasons(full.subarray(0, full.length - 10));
  assert.deepEqual(reg, BASE_REGISTER);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0]!, /unreadable sync tail/);

  // A tail cut inside its length varint.
  const cut = decodeWithReasons(Buffer.concat([registerV2(), Buffer.from([0x80])]));
  assert.deepEqual(cut.reg, BASE_REGISTER);
  assert.equal(cut.reasons.length, 1);
});

test('register: a tail with wrong field types is ignored', () => {
  for (const bad of [{ ...SYNC, fp: 7 }, { ...SYNC, dv: '4790' }, { ...SYNC, cfg: undefined }, [SYNC]]) {
    const { reg, reasons } = decodeWithReasons(registerV2((w) => w.utf(JSON.stringify(bad))));
    assert.equal(reg.sync, undefined, JSON.stringify(bad));
    assert.equal(reasons.length, 1);
  }
});

test('presence: the sync stamp passes through on join and on snapshot entries', () => {
  const stamp = { g: 'evol', v: 7, m: '01HZX0000000000000000000AA' };
  const join = decodePresence(encodeJsonPayload(JSON.stringify({ event: 'join', player: { uuid: UUID, name: 'Steve', sync: stamp } })));
  assert.deepEqual(join.player?.sync, stamp);

  const snap = decodePresence(
    encodeJsonPayload(
      JSON.stringify({
        event: 'snapshot',
        online: [
          { uuid: UUID, name: 'Steve', sync: { g: 'evol', v: 3 } },
          { uuid: '11111111-2222-3333-4444-555555555555', name: 'Alex' },
        ],
      }),
    ),
  );
  assert.deepEqual(snap.online?.[0]?.sync, { g: 'evol', v: 3 });
  assert.equal(snap.online?.[1]?.sync, undefined);

  const quit = decodePresence(encodeJsonPayload(JSON.stringify({ event: 'quit', player: { uuid: UUID, name: 'Steve' } })));
  assert.equal(quit.player?.sync, undefined);
});

// ── syncsnap ─────────────────────────────────────────────────────────────────

const GZ = Buffer.from([31, 139, 8, 0, 9, 8, 7, 6, 5]);
const SHA = createHash('sha256').update(GZ).digest('hex');

function header(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'shadow',
    uuid: UUID.toUpperCase(),
    name: 'Steve',
    v: 0,
    fp: 'ab'.repeat(32),
    dv: 4790,
    sha256: SHA.toUpperCase(),
    gzLen: GZ.length,
    rawLen: 120,
    blocked: [{ where: 'Inventory', slot: 3, id: 'dankstorage:dank_1', reason: 'block', detail: 'refs.items' }, 'junk'],
    links: [{ where: 'EnderItems', slot: '0', id: 'x:y', component: 'x:link' }],
    worldData: [{ h: 'sophisticatedbackpacks', key: 'k-1', rawLen: 64 }],
    playerData: ['puffish_skills', 5],
    tookMs: 12,
    at: 1760000000000,
    ...overrides,
  };
}

function syncsnap(h: Record<string, unknown>, gz: Buffer = GZ, declaredLen = gz.length, ver = 1): Buffer {
  return Buffer.concat([new Writer().varInt(ver).utf(JSON.stringify(h)).varInt(declaredLen).build(), gz]);
}

test('syncsnap: a valid shadow message decodes; uuid and sha256 come out lowercase', () => {
  const { header: h, gz } = decodeSyncSnap(syncsnap(header()));
  assert.deepEqual([...gz], [...GZ]);
  assert.equal(h.kind, 'shadow');
  assert.equal(h.uuid, UUID);
  assert.equal(h.sha256, SHA);
  assert.equal(h.v, 0);
  assert.equal(h.gzLen, GZ.length);
  assert.equal(h.dv, 4790);
  assert.equal(h.group, undefined, 'shadow carries no group');
  assert.deepEqual(h.blocked, [
    { where: 'Inventory', slot: '3', id: 'dankstorage:dank_1', reason: 'block', detail: 'refs.items' },
    { where: '', slot: '', id: '', reason: 'block' },
  ]);
  assert.deepEqual(h.links, [{ where: 'EnderItems', slot: '0', id: 'x:y', component: 'x:link' }]);
  assert.deepEqual(h.worldData, [{ h: 'sophisticatedbackpacks', key: 'k-1', rawLen: 64 }]);
  assert.deepEqual(h.playerData, ['puffish_skills']);
});

test('syncsnap: release keeps group and moveId', () => {
  const { header: h } = decodeSyncSnap(syncsnap(header({ kind: 'release', group: 'evol', moveId: 'M1', v: 8 })));
  assert.equal(h.kind, 'release');
  assert.equal(h.group, 'evol');
  assert.equal(h.moveId, 'M1');
  assert.equal(h.v, 8);
});

test('syncsnap: pre_action keeps group, action and backupId; a non-string action is dropped', () => {
  const { header: h } = decodeSyncSnap(syncsnap(header({ kind: 'pre_action', group: 'evol', v: 4, action: 'fresh', backupId: '20261010T193000Z-fresh' })));
  assert.equal(h.kind, 'pre_action');
  assert.equal(h.group, 'evol');
  assert.equal(h.action, 'fresh');
  assert.equal(h.backupId, '20261010T193000Z-fresh');
  assert.equal(h.moveId, undefined);
  const { header: odd } = decodeSyncSnap(syncsnap(header({ kind: 'pre_action', action: 7, backupId: '' })));
  assert.equal(odd.action, undefined);
  assert.equal(odd.backupId, undefined);
});

test('syncsnap: bad version, kind, uuid and v are refused', () => {
  assert.throws(() => decodeSyncSnap(syncsnap(header(), GZ, GZ.length, 2)), /unsupported syncsnap version/);
  assert.throws(() => decodeSyncSnap(syncsnap(header({ kind: 'backup' }))), /kind backup is unknown/);
  assert.throws(() => decodeSyncSnap(syncsnap(header({ uuid: 42 }))), /uuid/);
  assert.throws(() => decodeSyncSnap(syncsnap(header({ uuid: 'not-a-uuid' }))), /uuid/);
  assert.throws(() => decodeSyncSnap(syncsnap(header({ v: '7' }))), /v is not a version/);
  assert.throws(() => decodeSyncSnap(syncsnap(header({ v: -1 }))), /v is not a version/);
  assert.throws(() => decodeSyncSnap(syncsnap(header({ sha256: undefined }))), /sha256 is missing/);
});

test('syncsnap: gzLen must equal the bytes present and the header gzLen', () => {
  assert.throws(() => decodeSyncSnap(syncsnap(header(), GZ, GZ.length + 1)), /bytes present/);
  assert.throws(() => decodeSyncSnap(syncsnap(header(), Buffer.concat([GZ, Buffer.from([0])]), GZ.length)), /bytes present/);
  assert.throws(() => decodeSyncSnap(syncsnap(header({ gzLen: GZ.length + 5 }))), /header gzLen/);
});

test('syncsnap: a sha256 that does not match the gz is refused', () => {
  assert.throws(() => decodeSyncSnap(syncsnap(header({ sha256: 'f'.repeat(64) }))), /sha256 does not match/);
});

test('syncsnap: a gz over the 8 MiB cap is refused before any byte is read', () => {
  const payload = new Writer().varInt(1).utf(JSON.stringify(header())).varInt(SYNCSNAP_MAX_GZ_BYTES + 1).build();
  assert.throws(() => decodeSyncSnap(payload), /outside 0\.\.8388608/);
});
