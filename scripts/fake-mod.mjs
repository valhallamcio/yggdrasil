#!/usr/bin/env node
/**
 * Fake Biforesting backend — a *client* emulator for the Yggdrasil play-phase link.
 *
 * The mod is the client and Yggdrasil the server, so `bifrost-lib/test/ygg_mock.py` (a listener)
 * can't drive Yggdrasil. This connects to a running Yggdrasil, sends a signed `hello` + periodic
 * `metrics` + a one-time `registry` (+ optional `quest`/`chunks`), and prints any DOWN frames it
 * receives. Mirrors `YggdrasilLink.java` framing and `PlayFrameCodec.java` signing.
 *
 *   BIFORESTING_PSK=<psk> node scripts/fake-mod.mjs [host] [port] [serverId]     # WS /biforesting/ on the main HTTP port
 *   BIFORESTING_AUTHKEY_HEX=<64hex> node scripts/fake-mod.mjs 127.0.0.1 3000 my-server
 *
 * WS-only since phase 9 (the raw-TCP listener is gone; --ws is still accepted as a no-op).
 * Mirrors the mod's WebSocketClient: one outer unit per binary message, default port 3000.
 * Flags via env: SEND_QUEST=1 SEND_CHUNKS=1 BAD_KEY=1 (sign with a wrong key → all frames rejected).
 * DOWN frames are checked (HMAC, replay window) and chunked DOWN messages are reassembled. An op
 * on the v2 envelope (`[varint 2][utf json][varint blobLen][blob]`) has its blob read.
 *
 * Durable-ops emulation via `--op-mode <mode>` (how DOWN `biforesting:op` is answered):
 *   ack-ok    (default) ack, then a completed result — the happy path
 *   ack-drop  ack, never a result             → exercises the exec-timeout sweep
 *   drop      no response at all              → exercises the dispatch-timeout requeue
 *   dup       ack + result sent TWICE         → exercises store transition idempotency
 *   waiting   result status=waiting_player, then a presence join 2 s later; a re-dispatched
 *             op completes → exercises the waiting_player → presence → requeue path
 *
 * In ack-ok mode `profile_capture` behaves like the profiler: ack, a result with `captureId`
 * after min(seconds, 2) s, then a signed PUT of a small report.json and trace.json.gz to the
 * op's `uploadUrl`. `profile_stop` completes with `stopped: false`. `profile_fetch` PUTs a
 * report.json and trace.json.gz for the requested captureId and lists the rest as missing.
 * SEND_SPIKE=1 sends one `biforesting:spike` payload (a spike catcher dump report) at connect.
 *
 * Player sync S1 (bifrost-lib docs/invariants/player-sync.md): SEND_SYNC=1 adds the fingerprint
 * tail to `register` and sends one `biforesting:syncsnap` of kind `shadow` for TestPlayer.
 * SYNC_FP=<hex> sets the fingerprint (two fake mods with equal SYNC_FP match). SYNC_BLOCKED=1
 * puts one blocked item in the snapshot header. Combine with SEND_PRESENCE=1 and CAPS=0x80c10
 * (play_transport, ops, presence, player_sync) to feed the shadow ledger.
 *
 * Player sync S2/S3, `--sync`: emulates one 26.1.2 instance of a sync group.
 *   node scripts/fake-mod.mjs 127.0.0.1 3123 aaaa0001 --sync --fp <hex> --control-port 3201 [--fault '<json>']
 * It advertises play_transport, ops, presence and player_sync (CAPS overrides), sends the register
 * sync tail, keeps per-uuid state in memory (a fake `.dat` as JSON with the stamp at
 * NeoForgeData.PlayerPersisted.biforesting_sync, the online set, `moving`, `away`, world-data
 * records with `out`, `tombstone` and `foreign` locks, player handler data) and answers the ten
 * sync ops per spec 3.5. It reconnects when the link drops. The control port (HTTP on 127.0.0.1)
 * drives it:
 *   GET  /state                     the whole fake state
 *   POST /seed {uuid,name,dat?,worldData?:{h:{key:rec}},playerData?:{h:data}}
 *   POST /join {uuid,name}          a login; refused for a `moving` or `away` uuid
 *   POST /quit {uuid}               a logout: quit save, presence quit, shadow syncsnap
 *   POST /fault {...}               merge fault flags; {reset:true} clears them
 *   POST /disconnect {holdDown?}    drop the link; holdDown waits for /reconnect
 *   POST /reconnect {fp?}           reconnect now, with a new fingerprint when given
 *   POST /restore {stamps?:{uuid:stamp|null}, dropAway?:[uuid], dropMoving?:[uuid],
 *                  away?:{uuid:{v,m,to,toLabel}}, moving?:{uuid:moveId},
 *                  worldData?:{h:{key:rec}}, locks?:{'<h>:<key>':lock|null}}
 *                                   a restore from a backup: each listed .dat gets the stamp it had
 *                                   then (null: none), the listed away and moving marks go, and the
 *                                   marks, world-data records and locks the backup held come back
 *                                   (a null lock: the backup had none)
 *   POST /open {h,key}              open a world-data record: {refused: <text>|null} (spec 3.7)
 * Fault flags (counts are "times left"; a missing count means every time):
 *   dropResult: {<type>: n}                      run the op, ack, never send its result
 *   answerCode: {<type>: {code, count?}}         answer the op as failed with that code, run nothing
 *   delayMs: {<type>|'*': ms}                    wait before the ack and the result
 *   disconnectAfter: {type, execute?, holdDown?, count?}   drop the link on receipt; run the op after when execute
 *   blockAt: {prepare?: n, release?: n}          the reference scan reports one extra blocked item
 *   failAfterRun: {<type>: {code, count?}}       run the op, then answer it as failed with that code
 *   crashBeforeStateSave: {sync_apply: n}        the apply writes the .dat, then "crashes": away and
 *                                                moving stay, no result, the link drops and comes back
 *   saltRelease: true                            a release re-run builds another blob (another sha256)
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { gunzipSync, gzipSync } from 'node:zlib';
import WebSocket from 'ws';

const args = process.argv.slice(2);
// --ws kept as an accepted no-op so existing invocations keep working (WS is the only transport)
const VALUE_FLAGS = ['--op-mode', '--fp', '--control-port', '--fault'];
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (VALUE_FLAGS.includes(a)) flags[a] = args[++i];
  else if (a === '--ws') continue;
  else if (a === '--sync') flags[a] = true;
  else positional.push(a);
}
const opMode = flags['--op-mode'] ?? 'ack-ok';
const SYNC_MODE = flags['--sync'] === true;
const host = positional[0] ?? '127.0.0.1';
const port = Number(positional[1] ?? 3000);
const serverId = positional[2] ?? 'test';

function authKey() {
  if (process.env.BAD_KEY) return randomBytes(32);
  const hex = (process.env.BIFORESTING_AUTHKEY_HEX ?? '').trim();
  if (hex) {
    if (hex.length !== 64) throw new Error('BIFORESTING_AUTHKEY_HEX must be 64 hex chars');
    return Buffer.from(hex, 'hex');
  }
  const psk = process.env.BIFORESTING_PSK;
  if (!psk) throw new Error('Set BIFORESTING_PSK or BIFORESTING_AUTHKEY_HEX');
  return pbkdf2Sync(psk, 'Biforesting-ProxyAuth-v1', 10_000, 32, 'sha256');
}
const KEY = authKey();

// ── wire helpers ─────────────────────────────────────────────────────────────
function vint(n) {
  const out = [];
  let v = n >>> 0;
  for (;;) {
    const b = v & 0x7f;
    v >>>= 7;
    if (v) out.push(b | 0x80);
    else { out.push(b); break; }
  }
  return Buffer.from(out);
}
function utf(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([vint(b.length), b]);
}
function i64(n) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n)); return b; }
function f32(n) { const b = Buffer.alloc(4); b.writeFloatBE(n); return b; }

let msgSeq = 0;
function macInput(channel, messageId, seq, total, ts, nonce, chunk) {
  const ch = Buffer.from(channel, 'utf8');
  return Buffer.concat([vint(ch.length), ch, vint(messageId), vint(seq), vint(total), i64(ts), i64(nonce), chunk]);
}
function signFrame(channel, payload) {
  const messageId = (++msgSeq) & 0x7fffffff;
  const seq = 0, total = 1;
  const ts = Date.now();
  const nonce = randomBytes(8).readBigInt64BE(0);
  const sig = createHmac('sha256', KEY).update(macInput(channel, messageId, seq, total, ts, nonce, payload)).digest();
  return Buffer.concat([vint(1), vint(messageId), vint(seq), vint(total), i64(ts), i64(nonce), vint(payload.length), payload, sig]);
}
function buildUnit(channel, payload) {
  const frame = signFrame(channel, payload);
  const ch = Buffer.from(channel, 'utf8');
  const head = Buffer.alloc(2 + ch.length + 4);
  head.writeUInt16BE(ch.length, 0);
  ch.copy(head, 2);
  head.writeInt32BE(frame.length, 2 + ch.length);
  return Buffer.concat([head, frame]);
}
// transport.send is set per connection: one outer unit per WS binary message. False when the link is down.
const transport = { send: null };
function sendUnit(_sock, channel, payload) {
  return transport.send ? transport.send(buildUnit(channel, payload)) : false;
}

// ── payload builders ─────────────────────────────────────────────────────────
const metrics = () =>
  Buffer.concat([vint(1), f32(45 + Math.random() * 5), f32(20), vint(0), vint(3), vint(900), i64(120 * 1024 * 1024), i64(512 * 1024 * 1024)]);
// v1 registry (id→numericId only) — kept behind V1_REGISTRY for the v1-compat decode path.
const registryV1 = () =>
  Buffer.concat([vint(1), vint(3), utf('minecraft:dirt'), vint(9), utf('minecraft:stone'), vint(1), utf('create:cogwheel'), vint(7777)]);
// v2 item registry (phase 8): [ver=2][varint gzLen][gz utf8-json] — mirrors shared ItemRegistryPayloads.
const registryV2 = () => {
  const gz = gzipSync(Buffer.from(JSON.stringify({
    source: 'forge-1.12',
    count: 3,
    complete: true,
    stats: { enumerated: 3, variants: 4 },
    items: [
      { id: 'minecraft:stone', mod: 'minecraft', display: 'Stone', maxStack: 64 },
      { id: 'minecraft:dirt', num: 3, mod: 'minecraft', display: 'Dirt', maxStack: 64 },
      { id: 'gregtech:gt.metaitem.01', num: 4097, mod: 'gregtech', display: 'Meta Item', maxStack: 64,
        variants: [{ meta: 32001, display: 'Copper Dust' }, { meta: 32002, display: 'Tin Dust' }] },
    ],
  }), 'utf8'));
  return Buffer.concat([vint(2), vint(gz.length), gz]);
};
const registry = () => (process.env.V1_REGISTRY ? registryV1() : registryV2());
const quest = () =>
  Buffer.concat([vint(1), vint(1), utf('11111111-2222-3333-4444-555555555555'), vint(3700), utf('{progress:[I;1,2,3]}')]);
// register v2: [ver=2][utf serverId][utf hint][varint caps][utf node][utf gameAddr][i64 bootNonce][varint linkProto=2]
// + with SEND_SYNC or --sync the optional [utf syncJson] tail (player-sync spec 3.2)
const BOOT_NONCE = BigInt(Date.now()) * 1000n + BigInt(process.pid % 1000);
let SYNC_FP = flags['--fp'] ?? process.env.SYNC_FP ?? createHash('sha256').update('fake-mod fingerprint').digest('hex');
const SYNC_DV = 4790;
const CAPS_SYNC = 0x10 | 0x400 | 0x800 | 0x80000; // play_transport, ops, presence, player_sync
const PLAYER_SYNC = 0x80000;
const syncTail = () =>
  process.env.SEND_SYNC || SYNC_MODE
    ? utf(JSON.stringify({ fp: SYNC_FP, dv: SYNC_DV, mods: 312, items: 41829, cfg: createHash('sha256').update('fake-mod cfg').digest('hex') }))
    : Buffer.alloc(0);
const caps = () => Number(process.env.CAPS ?? (SYNC_MODE ? CAPS_SYNC : 0x10));
const register = () =>
  Buffer.concat([vint(2), utf(serverId), utf('fake-mod'), vint(caps()), utf('fake-node'), utf('127.0.0.1:25565'), i64(BOOT_NONCE), vint(2), syncTail()]);
// syncsnap: [ver=1][utf header json][varint gzLen][gz] — the gz is opaque to yggdrasil, only its sha256 is checked
const syncSnap = () => {
  const gz = gzipSync(Buffer.from('fake NBT root compound', 'utf8'));
  const header = {
    kind: 'shadow',
    uuid: '00000000-0000-0000-0000-000000000001',
    name: 'TestPlayer',
    v: 0,
    fp: SYNC_FP,
    dv: 4790,
    sha256: createHash('sha256').update(gz).digest('hex'),
    gzLen: gz.length,
    rawLen: 22,
    blocked: process.env.SYNC_BLOCKED
      ? [{ where: 'Inventory', slot: '3', id: 'dankstorage:dank_1', reason: 'block', detail: 'refs.items dankstorage:*' }]
      : [],
    links: [],
    worldData: [],
    playerData: ['puffish_skills'],
    tookMs: 4,
    at: Date.now(),
  };
  return Buffer.concat([vint(1), utf(JSON.stringify(header)), vint(gz.length), gz]);
};
const chunks = () =>
  Buffer.concat([vint(1), vint(1), utf('11111111-2222-3333-4444-555555555555'), vint(1), utf('minecraft:overworld'), vint(0), vint(0), Buffer.from([1])]);

// ── inbound (DOWN): outer units → checked frames → reassembled messages ─────
function readVar(buf, off) {
  let value = 0, pos = 0, size = 0;
  for (;;) {
    const b = buf[off + size++];
    value |= (b & 0x7f) << pos;
    if (!(b & 0x80)) break;
    pos += 7;
  }
  return [value, size];
}

/** One DOWN frame, checked like the mod's PlayFrameCodec.decode. Null when it fails a check. */
function decodeDownFrame(channel, frame) {
  try {
    let o = 0;
    const field = () => { const [v, s] = readVar(frame, o); o += s; return v; };
    if (field() !== 1) return null;
    const messageId = field();
    const seq = field();
    const total = field();
    const ts = frame.readBigInt64BE(o); o += 8;
    const nonce = frame.readBigInt64BE(o); o += 8;
    const chunkLen = field();
    if (total < 1 || seq < 0 || seq >= total || chunkLen < 0 || o + chunkLen + 32 > frame.length) return null;
    const chunk = frame.subarray(o, o + chunkLen);
    const sig = frame.subarray(o + chunkLen, o + chunkLen + 32);
    if (Math.abs(Date.now() - Number(ts)) > 30_000) return null;
    const want = createHmac('sha256', KEY).update(macInput(channel, messageId, seq, total, ts, nonce, chunk)).digest();
    if (!timingSafeEqual(sig, want)) return null;
    return { messageId, seq, total, chunk: Buffer.from(chunk) };
  } catch {
    return null;
  }
}

/** Partial DOWN messages by `channel:messageId`. Mirrors the mod's Reassembler. */
const inflight = new Map();
function reassemble(channel, f) {
  if (f.total === 1) return f.chunk;
  const key = `${channel}:${f.messageId}`;
  let p = inflight.get(key);
  if (p && p.total !== f.total) { inflight.delete(key); p = undefined; }
  if (!p) {
    if (inflight.size >= 64) inflight.clear();
    p = { total: f.total, parts: new Array(f.total).fill(null), received: 0 };
    inflight.set(key, p);
  }
  if (p.parts[f.seq] !== null) return null;
  p.parts[f.seq] = f.chunk;
  if (++p.received < p.total) return null;
  inflight.delete(key);
  return Buffer.concat(p.parts);
}

let inbuf = Buffer.alloc(0);
let downRejected = 0;
let downChunked = 0;
function onData(data) {
  inbuf = Buffer.concat([inbuf, data]);
  for (;;) {
    if (inbuf.length < 2) return;
    const clen = inbuf.readUInt16BE(0);
    if (inbuf.length < 2 + clen + 4) return;
    const channel = inbuf.toString('utf8', 2, 2 + clen);
    const flen = inbuf.readInt32BE(2 + clen);
    if (inbuf.length < 2 + clen + 4 + flen) return;
    const frame = inbuf.subarray(2 + clen + 4, 2 + clen + 4 + flen);
    inbuf = inbuf.subarray(2 + clen + 4 + flen);
    const f = decodeDownFrame(channel, frame);
    if (!f) {
      downRejected++;
      console.log(`[fake-mod] DOWN ${channel}: frame rejected (HMAC or replay window)`);
      continue;
    }
    if (f.total > 1) downChunked++;
    const payload = reassemble(channel, f);
    if (!payload) continue;
    console.log(`[fake-mod] DOWN ${channel}: ${payload.length}B payload${f.total > 1 ? ` (${f.total} chunks)` : ''}`);
    if (channel === 'biforesting:op') onOp(payload);
    else if (channel === 'biforesting:reg_ack') onRegAck(payload);
  }
}

/** reg_ack v2: [varint 2][byte accepted][utf canonical][utf friendly][varint enabledFeatures]... */
function onRegAck(payload) {
  let o = 0;
  const field = () => { const [v, s] = readVar(payload, o); o += s; return v; };
  const str = () => { const n = field(); const s = payload.toString('utf8', o, o + n); o += n; return s; };
  field();
  const accepted = payload[o++] === 1;
  str();
  str();
  const enabled = field();
  sync.registered = accepted;
  sync.granted = enabled >>> 0;
  console.log(`[fake-mod] reg_ack accepted=${accepted} enabledFeatures=0x${sync.granted.toString(16)}`);
}

// ── durable-ops emulation ────────────────────────────────────────────────────
const jsonPayload = (obj) => Buffer.concat([vint(1), utf(JSON.stringify(obj))]);
const seenOps = new Set(); // opIds already answered `waiting` (a re-dispatch completes)

/** `[varint 1][utf json]`, or v2 `[varint 2][utf json][varint blobLen][blob]`. */
function decodeOp(payload) {
  let o = 0;
  const [ver, vs] = readVar(payload, o); o += vs;
  const [slen, ss] = readVar(payload, o); o += ss;
  const op = JSON.parse(payload.toString('utf8', o, o + slen));
  o += slen;
  let blob = null;
  if (ver === 2) {
    const [blen, bs] = readVar(payload, o); o += bs;
    blob = Buffer.from(payload.subarray(o, o + blen));
  }
  return { op, blob };
}

function onOp(payload) {
  const { op, blob } = decodeOp(payload);
  console.log(`[fake-mod] op ${op.opId} type=${op.type} mode=${opMode}${blob ? ` blob=${blob.length}B` : ''}`);
  if (SYNC_MODE && op.type.startsWith('sync_')) {
    onSyncOp(op, blob);
    return;
  }
  const ack = () => sendUnit(null, 'biforesting:op_res', jsonPayload({ opId: op.opId, phase: 'ack' }));
  const result = (extra) =>
    sendUnit(null, 'biforesting:op_res', jsonPayload({ opId: op.opId, phase: 'result', durationMs: 5, ...extra }));
  const completed = () => result({ status: 'completed', result: { echoed: op.params?.message ?? null } });

  if (opMode === 'ack-ok' && op.type === 'profile_capture') {
    ack();
    void fakeCapture(op, result).catch((e) => console.error('[fake-mod] profile upload error:', e.message));
    return;
  }
  if (opMode === 'ack-ok' && op.type === 'profile_fetch') {
    ack();
    void fakeFetch(op, result).catch((e) => console.error('[fake-mod] profile fetch error:', e.message));
    return;
  }
  if (opMode === 'ack-ok' && op.type === 'profile_stop') {
    ack();
    result({ status: 'completed', result: { stopped: false, reason: 'no capture running' } });
    return;
  }

  switch (opMode) {
    case 'drop':
      break;
    case 'ack-drop':
      ack();
      break;
    case 'dup':
      ack(); completed();
      ack(); completed();
      break;
    case 'waiting': {
      ack();
      if (seenOps.has(op.opId)) { completed(); break; }
      seenOps.add(op.opId);
      result({ status: 'waiting_player' });
      const target = op.target ?? { uuid: '00000000-0000-0000-0000-000000000001', name: 'TestPlayer' };
      setTimeout(() => {
        console.log(`[fake-mod] presence join ${target.name ?? target.uuid}`);
        sendUnit(null, 'biforesting:presence', jsonPayload({ event: 'join', player: { uuid: target.uuid ?? '', name: target.name ?? '' } }));
      }, 2000);
      break;
    }
    case 'ack-ok':
    default:
      ack(); completed();
      break;
  }
}

// ── profiler emulation ───────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeReport(captureId, level, sampler, seconds, spike = false) {
  const hot = (id, kind, mod, className, ms, share, count, method) => ({
    id: `${kind}/${id}`, name: id, kind, mod, className,
    msPerTick: ms, msPerTickP50: ms * 0.9, msPerTickP95: ms * 1.4, selfMsTotal: ms * 40, inclMsTotal: ms * 42,
    share, count, countPerTick: count / 40, costPerInstanceUs: (ms * 1000) / Math.max(1, count / 40),
    topPositions: [{ dim: 'minecraft:overworld', x: 120, y: 64, z: -340, ms: ms * 30, count: 40 }],
    samples: 20, topMethods: [{ frame: method, samples: 14, share: 0.7 }], spikeTicks: [],
  });
  const now = Date.now();
  const spikeFields = spike
    ? {
        kind: 'spike',
        trigger: {
          tick: 200, tickMs: 812.4, thresholdMs: 250, at: new Date(now - 3000).toISOString(), preMs: 10000, postMs: 3000,
          windowPreMs: 10000, windowPostMs: 3000, spikesInWindow: 1, suppressed: 0, suppressedMaxMs: 0, minIntervalMs: 300000,
          messages: [{ atMs: 10001.5, text: 'GC G1 Young Generation (end of minor GC, G1 Evacuation Pause) 41 ms' }],
        },
      }
    : {};
  return {
    schema: 1, captureId, ...spikeFields,
    startedAt: new Date(now - seconds * 1000).toISOString(), stoppedAt: new Date(now).toISOString(),
    durationMs: seconds * 1000, stopReason: 'maxSeconds', level: String(level).toUpperCase(), sampler,
    maxSeconds: seconds, maxBytes: 67108864, truncated: false, tickCount: seconds * 20, analysisTicks: seconds * 20,
    mspt: { p50: 21.4, p95: 38.2, p99: 61.0, max: 74.3, avg: 24.8 }, tps: 19.6,
    server: { serverId, mcVersion: '1.7.10', loader: 'forge' },
    jvm: { name: 'fake', version: '0', vendor: 'fake-mod', javaVersion: '8', gc: ['G1'], heapMaxMb: 8192 },
    modList: [{ id: 'gregtech', version: '5.09', jar: 'gregtech.jar' }, { id: 'minecraft', version: '1.7.10' }],
    events: { zones: 1000, counters: 0, messages: 0, droppedMessages: 0, bytes: 1024, tracks: 1 },
    samples: { intervalMs: 10, total: 200, stacks: 5, overflow: 0, errors: 0 },
    notes: ['fake-mod capture'],
    hotspotsTotal: 3,
    hotspots: [
      hot('gregtech:multiblock', 'block_entity', 'gregtech', 'gregtech.api.metatileentity.BaseMetaTileEntity', 9.2, 0.37, 800, 'gregtech.api.util.GT_Recipe.findRecipe'),
      hot('minecraft:zombie', 'entity', 'minecraft', 'net.minecraft.entity.monster.EntityZombie', 3.1, 0.12, 2400, 'net.minecraft.pathfinding.PathFinder.findPath'),
      hot('minecraft:hopper', 'block_entity', 'minecraft', 'net.minecraft.tileentity.TileEntityHopper', 1.4, 0.06, 1200, 'net.minecraft.tileentity.TileEntityHopper.updateHopper'),
    ],
    worstTicks: [{ tick: 17, startMs: 850.2, ms: 74.3, zones: [{ id: 'block_entity/gregtech:multiblock', name: 'gregtech:multiblock', selfMs: 60.1 }] }],
    mods: [
      { mod: 'gregtech', msPerTick: 9.2, share: 0.37, selfMsTotal: 368, version: '5.09', jar: 'gregtech.jar' },
      { mod: 'minecraft', msPerTick: 4.5, share: 0.18, selfMsTotal: 180, version: '1.7.10' },
    ],
    counters: {}, threads: [{ tid: 1, name: 'Server thread', zones: 1000, counters: 0 }],
  };
}

function fakeTrace(seconds) {
  const traceEvents = [{ name: 'thread_name', ph: 'M', pid: 1, tid: 1, args: { name: 'Server thread' } }];
  for (let t = 0; t < seconds * 20; t++) {
    const ts = t * 50_000;
    traceEvents.push({ name: 'tick', ph: 'X', pid: 1, tid: 1, ts, dur: 24_000 });
    traceEvents.push({ name: 'gregtech:multiblock', ph: 'X', pid: 1, tid: 1, ts: ts + 1_000, dur: 9_000 });
  }
  return gzipSync(Buffer.from(JSON.stringify({ traceEvents }), 'utf8'));
}

async function uploadArtifact(uploadUrl, token, captureId, artifact, body) {
  const ts = Date.now();
  const sha = createHash('sha256').update(body).digest('hex');
  // serverId here is our own link serverId. Yggdrasil puts the same value in uploadUrl.
  const sig = createHmac('sha256', KEY).update(`${serverId}\n${captureId}\n${artifact}\n${sha}\n${ts}`, 'utf8').digest('hex');
  const res = await fetch(`${uploadUrl}${encodeURIComponent(captureId)}/${artifact}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Bf-Upload-Token': token,
      'X-Bf-Timestamp': String(ts),
      'X-Bf-Content-Sha256': sha,
      'X-Bf-Signature': sig,
    },
    body,
  });
  return `${res.status} ${(await res.text()).slice(0, 200)}`;
}

async function fakeCapture(op, result) {
  const { seconds = 30, level = 'l1', sampler = 'java', uploadToken, uploadUrl } = op.params ?? {};
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const captureId = `fake-${stamp}-${randomBytes(2).toString('hex')}`;
  await sleep(Math.min(seconds, 2) * 1000);
  result({ status: 'completed', result: { captureId, level, sampler, seconds, artifacts: ['report.json', 'trace.json.gz'] } });
  if (!uploadToken || !uploadUrl) {
    console.log('[fake-mod] profile_capture carried no upload grant, nothing to upload');
    return;
  }
  const artifacts = [
    ['report.json', Buffer.from(JSON.stringify(fakeReport(captureId, level, sampler, seconds)), 'utf8')],
    ['trace.json.gz', fakeTrace(Math.min(seconds, 10))],
  ];
  for (const [artifact, body] of artifacts) {
    console.log(`[fake-mod] PUT ${captureId}/${artifact} (${body.length}B): ${await uploadArtifact(uploadUrl, uploadToken, captureId, artifact, body)}`);
  }
}

async function fakeFetch(op, result) {
  const { captureId, artifacts, uploadToken, uploadUrl } = op.params ?? {};
  const wanted = artifacts ?? ['report.json', 'report.md', 'trace.json.gz', 'samples.collapsed', 'samples.jfr'];
  const have = {
    'report.json': () => Buffer.from(JSON.stringify(fakeReport(captureId, 'l0', 'none', 13, true)), 'utf8'),
    'trace.json.gz': () => fakeTrace(13),
  };
  const uploaded = [];
  const alreadyStored = [];
  const uploadErrors = [];
  const missing = wanted.filter((a) => !have[a]);
  for (const a of wanted.filter((x) => have[x])) {
    const status = await uploadArtifact(uploadUrl, uploadToken, captureId, a, have[a]());
    console.log(`[fake-mod] fetch PUT ${captureId}/${a}: ${status}`);
    if (status.startsWith('201')) uploaded.push(a);
    else if (status.startsWith('409')) alreadyStored.push(a);
    else uploadErrors.push(`${a}: HTTP ${status}`);
  }
  result({ status: 'completed', result: { captureId, uploaded, missing, alreadyStored, uploadErrors } });
}

/** `[varint 1][varint gzLen][gz report.json]`, mirrors the mod's SpikePayloads. */
function spikePayload() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const gz = gzipSync(Buffer.from(JSON.stringify(fakeReport(`spike-${serverId}-${stamp}`, 'l0', 'none', 13, true)), 'utf8'));
  return Buffer.concat([vint(1), vint(gz.length), gz]);
}

// ── player sync emulation (--sync, player-sync spec 3.3-3.7) ─────────────────

/** The carried part of the sync config (spec 3.1), cut down to what the e2e players hold. */
const CARRY_KEYS = ['Inventory', 'EnderItems', 'XpLevel', 'XpTotal', 'Health'];
const CARRY_ATTACHMENTS = ['curios:inventory'];
const ATTACHMENTS = 'neoforge:attachments';
const BACKPACKS = 'sophisticatedbackpacks';
const PUFFISH = 'puffish_skills';
const MAX_BLOB_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 8;
const TOMBSTONE_MS = 7 * 24 * 3600_000;
const LINK_COMPONENTS = new Set(['ae2:wireless_link_target', 'refinedstorage:network_location']);

const sync = {
  connected: false,
  registered: false,
  granted: 0,
  holdDown: false,
  connects: 0,
  /** uuid → fake `.dat` (a JSON object in the NBT shape). */
  dats: {},
  names: {},
  online: new Set(),
  /** uuid → moveId (spec 3.6). */
  moving: {},
  /** uuid → {v, m, to, toLabel, at}. */
  away: {},
  /** `<handler>:<key>` → {state: out|tombstone|foreign, moveId, to, toLabel?, until}. */
  locks: {},
  /** handler → key → record. A record is `{items:[stack...]}`. */
  worldData: { [BACKPACKS]: {} },
  /** handler → uuid → data. */
  playerData: { [PUFFISH]: {} },
  /** `<uuid>.presync-<v>` → the carried keys an apply replaced. */
  presync: {},
  /** opId → the op_res JSON already answered (the mod's op journal). */
  journal: new Map(),
  /** Every sync op received, in order. */
  opsSeen: [],
  kicks: [],
  refusals: [],
  sent: { syncsnap: 0, presence: 0 },
  faults: {},
  /** Release re-runs salted by the saltRelease fault. */
  rebuilds: 0,
};
if (flags['--fault']) sync.faults = JSON.parse(flags['--fault']);

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const sha256hex = (b) => createHash('sha256').update(b).digest('hex');

/** JSON with sorted object keys, so one state always gives the same bytes and sha256. */
function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

function stampOf(dat) {
  return dat?.NeoForgeData?.PlayerPersisted?.biforesting_sync ?? null;
}
function setStamp(dat, stamp) {
  dat.NeoForgeData ??= {};
  dat.NeoForgeData.PlayerPersisted ??= {};
  dat.NeoForgeData.PlayerPersisted.biforesting_sync = stamp;
}

/** The carried keys present in a `.dat` (spec 3.4 `carried`). */
function carriedOf(dat) {
  const out = {};
  for (const k of CARRY_KEYS) if (dat && k in dat) out[k] = clone(dat[k]);
  const att = {};
  for (const k of CARRY_ATTACHMENTS) if (dat?.[ATTACHMENTS] && k in dat[ATTACHMENTS]) att[k] = clone(dat[ATTACHMENTS][k]);
  if (Object.keys(att).length > 0) out[ATTACHMENTS] = att;
  return out;
}

/** Reference scan over the carried stacks (spec 3.9), nested containers and backpack records included. */
function scan(carried) {
  const report = { blocked: [], links: [], worldData: [] };
  const seenKeys = new Set();
  const walk = (where, slot, stack, depth) => {
    if (!stack || typeof stack !== 'object') return;
    const id = String(stack.id ?? '');
    if (depth > MAX_DEPTH) {
      report.blocked.push({ where, slot: String(slot), id, reason: 'too_deep' });
      return;
    }
    if (id.startsWith('dankstorage:') || id.startsWith('computercraft:')) {
      report.blocked.push({ where, slot: String(slot), id, reason: 'block', detail: `refs.items ${id.split(':')[0]}:*` });
    }
    for (const [type, value] of Object.entries(stack.components ?? {})) {
      if (type === 'sophisticatedcore:storage_uuid') {
        if (!id.startsWith(`${BACKPACKS}:`)) {
          report.blocked.push({ where, slot: String(slot), id, reason: 'handler_off:sophisticatedstorage' });
          continue;
        }
        const key = String(value);
        if (seenKeys.has(key)) {
          report.blocked.push({ where, slot: String(slot), id, reason: 'too_deep', detail: `cycle at ${key}` });
          continue;
        }
        seenKeys.add(key);
        report.worldData.push({ h: BACKPACKS, key });
        const rec = sync.worldData[BACKPACKS][key];
        (rec?.items ?? []).forEach((s, i) => walk(`${BACKPACKS}:${key}`, i, s, depth + 1));
      } else if (type === 'minecraft:container') {
        for (const e of value ?? []) walk(where, `${slot}/${e.slot}`, e.item, depth + 1);
      } else if (type === 'minecraft:bundle_contents') {
        (value ?? []).forEach((s, i) => walk(where, `${slot}/${i}`, s, depth + 1));
      } else if (LINK_COMPONENTS.has(type)) {
        report.links.push({ where, slot: String(slot), id, component: type });
      } else if (!type.startsWith('minecraft:')) {
        report.blocked.push({ where, slot: String(slot), id, reason: `unknown_component:${type}` });
      }
    }
  };
  for (const root of ['Inventory', 'EnderItems']) {
    for (const s of carried[root] ?? []) walk(root, s.Slot ?? '?', s, 0);
  }
  const curios = carried[ATTACHMENTS]?.['curios:inventory'];
  (curios?.items ?? []).forEach((s, i) => walk('curios', i, s, 0));
  return report;
}

function takeCount(table, key) {
  const n = table?.[key];
  if (n === undefined || n <= 0) return false;
  table[key] = n - 1;
  return true;
}

/** An extra blocked entry when the blockAt fault is armed for this step. */
function faultBlocked(step) {
  if (!takeCount(sync.faults.blockAt, step)) return [];
  return [{ where: 'Inventory', slot: '99', id: 'fake:fault_item', reason: 'block', detail: `fault injection at ${step}` }];
}

function sendPresence(event, players) {
  const body = event === 'snapshot' ? { event, online: players } : { event, player: players[0] };
  const sent = sendUnit(null, 'biforesting:presence', jsonPayload(body));
  if (sent) sync.sent.presence++;
  return sent;
}

function presencePlayer(uuid, withStamp) {
  const p = { uuid, name: sync.names[uuid] ?? '' };
  const st = withStamp ? stampOf(sync.dats[uuid]) : null;
  if (st) p.sync = { g: st.g, v: st.v, ...(st.m ? { m: st.m } : {}) };
  return p;
}

function sendSyncSnap(kind, uuid, extra, root, report) {
  const raw = Buffer.from(stableJson(root), 'utf8');
  const gz = gzipSync(raw);
  const header = {
    kind,
    uuid,
    name: sync.names[uuid] ?? '',
    v: extra.v ?? 0,
    ...(extra.group ? { group: extra.group } : {}),
    ...(extra.moveId ? { moveId: extra.moveId } : {}),
    fp: SYNC_FP,
    dv: SYNC_DV,
    sha256: sha256hex(gz),
    gzLen: gz.length,
    rawLen: raw.length,
    blocked: report?.blocked ?? [],
    links: report?.links ?? [],
    worldData: (report?.worldData ?? []).map((w) => ({ ...w, rawLen: stableJson(sync.worldData[w.h]?.[w.key] ?? null).length })),
    playerData: Object.keys(root.playerData ?? {}),
    tookMs: 1,
    at: Date.now(),
  };
  const sent = sendUnit(null, 'biforesting:syncsnap', Buffer.concat([vint(1), utf(JSON.stringify(header)), vint(gz.length), gz]));
  if (sent) sync.sent.syncsnap++;
  return { sent, sha256: header.sha256, gzLen: gz.length };
}

/** The spec 3.4 blob root of one player. */
function blobRoot(uuid, group, v, moveId, carried, worldKeys) {
  const playerData = {};
  if (sync.playerData[PUFFISH][uuid] !== undefined) playerData[PUFFISH] = clone(sync.playerData[PUFFISH][uuid]);
  const worldData = {};
  for (const { h, key } of worldKeys) {
    const rec = sync.worldData[h]?.[key];
    if (rec === undefined) continue;
    worldData[h] ??= {};
    worldData[h][key] = clone(rec);
  }
  return { DataVersion: SYNC_DV, uuid, group: group ?? '', v, moveId: moveId ?? '', carried, playerData, worldData };
}

/** Spec 3.8: a shadow syncsnap at quit, when player_sync is granted and the player is not moving. */
function shadowCapture(uuid) {
  if ((sync.granted & PLAYER_SYNC) === 0 || sync.moving[uuid]) return;
  const dat = sync.dats[uuid];
  const carried = carriedOf(dat);
  const report = scan(carried);
  const v = stampOf(dat)?.v ?? 0;
  sendSyncSnap('shadow', uuid, { v }, blobRoot(uuid, null, v, null, carried, report.worldData), report);
}

// ── op answers ──

const ok = (result) => ({ status: 'completed', result });
const fail = (code, error, result) => ({ status: 'failed', code, error, ...(result ? { result } : {}) });

function splitLockKey(lk) {
  const i = lk.indexOf(':');
  return { h: lk.slice(0, i), key: lk.slice(i + 1) };
}

const handlers = {
  sync_probe(op, uuid) {
    const foreign = Object.values(sync.locks).filter((l) => l.state === 'foreign').length;
    const dat = sync.dats[uuid];
    const st = stampOf(dat);
    const away = sync.away[uuid];
    return ok({
      online: sync.online.has(uuid),
      datExists: !!dat,
      ...(st ? { stamp: st } : {}),
      fp: SYNC_FP,
      ...(sync.moving[uuid] ? { moving: sync.moving[uuid] } : {}),
      ...(away ? { away: { v: away.v, m: away.m, to: away.to } } : {}),
      locks: Object.entries(sync.locks).map(([lk, l]) => ({ ...splitLockKey(lk), state: l.state, moveId: l.moveId })),
      ...(foreign > 0 ? { foreignLocks: foreign } : {}),
    });
  },

  sync_prepare(op, uuid) {
    const p = op.params;
    const online = sync.online.has(uuid);
    const report = scan(carriedOf(sync.dats[uuid]));
    report.blocked.push(...faultBlocked('prepare'));
    if (report.blocked.length > 0) return fail('blocked', `${report.blocked.length} item(s) cannot travel`, { blocked: report.blocked, links: report.links });
    sync.moving[uuid] = p.moveId;
    return ok({ armed: true, online, links: report.links });
  },

  /** Spec 3.5 order: final scan, blob, send the syncsnap, write the stamp, mark world data and away, answer. */
  sync_release(op, uuid) {
    const p = op.params;
    if (sync.online.has(uuid)) return fail('player_online', 'the player is online');
    const dat = sync.dats[uuid];
    if (!dat) return fail('no_dat', 'no .dat on the source');
    const st = stampOf(dat);
    const again = !!st && st.g === p.group && st.v === p.v && st.m === p.moveId;
    if (!again && st && st.v >= p.v) return fail('stale_version', `stamp v=${st.v} is not below ${p.v}`);
    const carried = carriedOf(dat);
    let worldKeys;
    if (again) {
      worldKeys = Object.entries(sync.locks)
        .filter(([, l]) => l.state === 'out' && l.moveId === p.moveId)
        .map(([lk]) => splitLockKey(lk));
    } else {
      const report = scan(carried);
      report.blocked.push(...faultBlocked('release'));
      if (report.blocked.length > 0) return fail('blocked', `${report.blocked.length} item(s) cannot travel`, { blocked: report.blocked, links: report.links });
      worldKeys = report.worldData;
    }
    const root = blobRoot(uuid, p.group, p.v, p.moveId, carried, worldKeys);
    if (again && sync.faults.saltRelease) root.rebuild = ++sync.rebuilds;
    if (gzipSync(Buffer.from(stableJson(root), 'utf8')).length > MAX_BLOB_BYTES) return fail(again ? 'handler_failed' : 'too_large', 'blob over maxBlobBytes');
    const snap = sendSyncSnap('release', uuid, { v: p.v, group: p.group, moveId: p.moveId }, root, { blocked: [], links: [], worldData: worldKeys });
    if (!snap.sent) return fail(again ? 'handler_failed' : 'not_applied', 'syncsnap send failed');
    if (!again) {
      setStamp(dat, { g: p.group, v: p.v, m: p.moveId });
      for (const { h, key } of worldKeys) sync.locks[`${h}:${key}`] = { state: 'out', moveId: p.moveId, to: p.to ?? '', until: null };
      sync.away[uuid] = { v: p.v, m: p.moveId, to: p.to ?? '', toLabel: p.toLabel ?? '', at: Date.now() };
    }
    return ok({ sha256: snap.sha256, gzLen: snap.gzLen, v: p.v, worldData: worldKeys, playerData: Object.keys(root.playerData) });
  },

  sync_apply(op, uuid, blob) {
    const p = op.params;
    if (sync.online.has(uuid)) return fail('player_online', 'the player is online');
    if (!blob || sha256hex(blob) !== p.sha256) return fail('bad_blob', 'blob sha256 does not match');
    let root;
    try {
      root = JSON.parse(gunzipSync(blob).toString('utf8'));
    } catch (e) {
      return fail('bad_blob', `blob decode failed: ${e.message}`);
    }
    if (p.fp !== SYNC_FP) return fail('fingerprint_mismatch', `op fp ${p.fp} != ${SYNC_FP}`);
    if (root.DataVersion !== SYNC_DV) return fail('fingerprint_mismatch', `blob DataVersion ${root.DataVersion} != ${SYNC_DV}`);
    let dat = sync.dats[uuid];
    const created = !dat;
    const st = stampOf(dat);
    if (st && st.v === p.v && st.m === p.moveId) {
      // The already path clears the marks too: a crash may have left them after the .dat write.
      delete sync.away[uuid];
      delete sync.moving[uuid];
      return ok({ applied: true, created: false, already: true, v: p.v });
    }
    if (st && st.v >= p.v) return fail('stale_version', `stamp v=${st.v} is not below ${p.v}`);
    if (dat) {
      const old = carriedOf(dat);
      sync.presync[`${uuid}.presync-${p.v}`] = old;
      sendSyncSnap('pre_sync', uuid, { v: st?.v ?? 0, group: p.group, moveId: p.moveId }, blobRoot(uuid, p.group, st?.v ?? 0, p.moveId, old, []), null);
    }
    for (const [h, recs] of Object.entries(root.worldData ?? {})) {
      sync.worldData[h] ??= {};
      for (const [key, rec] of Object.entries(recs)) {
        sync.worldData[h][key] = clone(rec);
        delete sync.locks[`${h}:${key}`];
      }
    }
    for (const [h, data] of Object.entries(root.playerData ?? {})) {
      sync.playerData[h] ??= {};
      sync.playerData[h][uuid] = clone(data);
    }
    if (!dat) dat = { DataVersion: SYNC_DV };
    for (const k of CARRY_KEYS) {
      if (k in (root.carried ?? {})) dat[k] = clone(root.carried[k]);
      else delete dat[k];
    }
    const att = root.carried?.[ATTACHMENTS] ?? {};
    for (const k of CARRY_ATTACHMENTS) {
      if (k in att) {
        dat[ATTACHMENTS] ??= {};
        dat[ATTACHMENTS][k] = clone(att[k]);
      } else if (dat[ATTACHMENTS]) delete dat[ATTACHMENTS][k];
    }
    setStamp(dat, { g: p.group, v: p.v, m: p.moveId });
    sync.dats[uuid] = dat;
    if (takeCount(sync.faults.crashBeforeStateSave, 'sync_apply')) return { crash: true };
    delete sync.away[uuid];
    delete sync.moving[uuid];
    return ok({ applied: true, created, already: false, v: p.v });
  },

  sync_commit(op, uuid) {
    const p = op.params;
    const removed = [];
    for (const [lk, l] of Object.entries(sync.locks)) {
      if (l.state !== 'out' || l.moveId !== p.moveId) continue;
      const { h, key } = splitLockKey(lk);
      delete sync.worldData[h]?.[key];
      sync.locks[lk] = { ...l, state: 'tombstone', until: Date.now() + TOMBSTONE_MS };
      removed.push({ h, key });
    }
    if (sync.moving[uuid] === p.moveId) delete sync.moving[uuid];
    return ok({ removed });
  },

  sync_abort(op, uuid) {
    const p = op.params;
    const released = [];
    for (const [lk, l] of Object.entries(sync.locks)) {
      if (l.state !== 'out' || l.moveId !== p.moveId) continue;
      delete sync.locks[lk];
      released.push(splitLockKey(lk));
    }
    if (sync.moving[uuid] === p.moveId) delete sync.moving[uuid];
    if (sync.away[uuid]?.m === p.moveId) delete sync.away[uuid];
    return ok({ released });
  },

  sync_kick(op, uuid) {
    const kicked = sync.online.has(uuid);
    if (kicked) {
      sync.online.delete(uuid);
      sync.kicks.push({ uuid, message: op.params.message, at: Date.now() });
      sendPresence('quit', [presencePlayer(uuid, false)]);
    }
    return ok({ kicked });
  },

  sync_disown(op) {
    let marked = 0;
    let skipped = 0;
    for (const e of op.params.entries ?? []) {
      const u = String(e.u).toLowerCase();
      const st = stampOf(sync.dats[u]);
      if (st && st.v > e.v) {
        skipped++;
        continue;
      }
      sync.away[u] = { v: e.v, m: 'disown', to: e.to ?? '', toLabel: e.toLabel ?? '', at: Date.now() };
      marked++;
    }
    return ok({ marked, skipped });
  },

  /** Spec 6.7: this instance owns each listed uuid. Old away and moving marks go; a newer away mark stays. */
  sync_own(op) {
    let cleared = 0;
    let kept = 0;
    for (const e of op.params.entries ?? []) {
      const u = String(e.u).toLowerCase();
      if (sync.away[u] && sync.away[u].v > e.v) {
        kept++;
        continue;
      }
      const had = !!sync.away[u] || !!sync.moving[u];
      delete sync.away[u];
      delete sync.moving[u];
      if (had) cleared++;
    }
    return ok({ cleared, kept });
  },

  /** Spec 6.7: another instance owns each listed record, or it is in transit. An out lock stays. */
  sync_lock(op) {
    let locked = 0;
    let kept = 0;
    for (const e of op.params.entries ?? []) {
      const lk = `${e.h}:${e.key}`;
      if (sync.locks[lk]?.state === 'out') {
        kept++;
        continue;
      }
      sync.locks[lk] = { state: 'foreign', moveId: '', to: e.to ?? '', toLabel: e.toLabel ?? '', until: null };
      locked++;
    }
    return ok({ locked, kept });
  },
};

/** One sync op at a time, like the mod's offline-edit guard. */
let syncChain = Promise.resolve();
function onSyncOp(op, blob) {
  sync.opsSeen.push({ opId: op.opId, type: op.type, uuid: op.target?.uuid ?? null, moveId: op.params?.moveId ?? null, at: Date.now() });
  const dc = sync.faults.disconnectAfter;
  if (dc && dc.type === op.type && (dc.count === undefined || dc.count > 0)) {
    if (dc.count !== undefined) dc.count--;
    console.log(`[fake-mod] fault: link drop after ${op.type} ${op.opId}${dc.execute ? ' (runs it)' : ''}`);
    dropLink(dc.holdDown !== false);
    if (dc.execute) syncChain = syncChain.then(() => runSyncOp(op, blob, true)).catch((e) => console.error('[fake-mod] sync op failed:', e));
    return;
  }
  syncChain = syncChain.then(() => runSyncOp(op, blob, false)).catch((e) => console.error('[fake-mod] sync op failed:', e));
}

async function runSyncOp(op, blob, silent) {
  const send = (obj) => (silent ? false : sendUnit(null, 'biforesting:op_res', jsonPayload(obj)));
  const replay = sync.journal.get(op.opId);
  if (replay) {
    console.log(`[fake-mod] op ${op.opId} answered from the journal`);
    send({ opId: op.opId, phase: 'ack' });
    send({ ...replay, journalReplay: true });
    return;
  }
  const delay = sync.faults.delayMs?.[op.type] ?? sync.faults.delayMs?.['*'] ?? 0;
  if (delay > 0) await sleep(delay);
  send({ opId: op.opId, phase: 'ack' });
  const started = Date.now();
  let out;
  const forced = sync.faults.answerCode?.[op.type];
  if (forced && (forced.count === undefined || forced.count > 0)) {
    if (forced.count !== undefined) forced.count--;
    out = fail(forced.code, `fault injection: ${forced.code}`);
  } else {
    const uuid = op.target?.uuid ? String(op.target.uuid).toLowerCase() : null;
    const h = handlers[op.type];
    if (!h) out = fail('unsupported_op', `${op.type} is not a sync op here`);
    else if (!['sync_disown', 'sync_own', 'sync_lock'].includes(op.type) && !uuid) out = fail('not_applied', `${op.type}: target.uuid must be a uuid`);
    else out = h(op, uuid, blob);
  }
  if (out.crash) {
    console.log(`[fake-mod] fault: crash in ${op.type} ${op.opId} before the state save; no result, link restarts`);
    dropLink(false);
    return;
  }
  const after = sync.faults.failAfterRun?.[op.type];
  if (after && out.status === 'completed' && (after.count === undefined || after.count > 0)) {
    if (after.count !== undefined) after.count--;
    out = fail(after.code, `fault injection after the op ran: ${after.code}`);
  }
  const msg = { opId: op.opId, phase: 'result', durationMs: Date.now() - started, ...out };
  sync.journal.set(op.opId, msg);
  if (takeCount(sync.faults.dropResult, op.type)) {
    console.log(`[fake-mod] fault: result of ${op.type} ${op.opId} dropped`);
    return;
  }
  send(msg);
  console.log(`[fake-mod] op ${op.opId} ${op.type} → ${out.status}${out.code ? ` ${out.code}` : ''}`);
}

// ── control channel ──

function syncState() {
  return {
    serverId,
    fp: SYNC_FP,
    connected: sync.connected,
    registered: sync.registered,
    granted: sync.granted,
    connects: sync.connects,
    downRejected,
    downChunked,
    dats: sync.dats,
    names: sync.names,
    online: [...sync.online],
    moving: sync.moving,
    away: sync.away,
    locks: sync.locks,
    worldData: sync.worldData,
    playerData: sync.playerData,
    presync: sync.presync,
    opsSeen: sync.opsSeen,
    kicks: sync.kicks,
    refusals: sync.refusals,
    sent: sync.sent,
    faults: sync.faults,
  };
}

const control = {
  seed(b) {
    const uuid = String(b.uuid).toLowerCase();
    if (b.name) sync.names[uuid] = b.name;
    if (b.dat === null) delete sync.dats[uuid];
    else if (b.dat) sync.dats[uuid] = { DataVersion: SYNC_DV, ...clone(b.dat) };
    for (const [h, recs] of Object.entries(b.worldData ?? {})) {
      sync.worldData[h] ??= {};
      Object.assign(sync.worldData[h], clone(recs));
    }
    for (const [h, data] of Object.entries(b.playerData ?? {})) {
      sync.playerData[h] ??= {};
      sync.playerData[h][uuid] = clone(data);
    }
    return { ok: true };
  },
  join(b) {
    const uuid = String(b.uuid).toLowerCase();
    if (b.name) sync.names[uuid] = b.name;
    let refused = null;
    if (sync.moving[uuid]) refused = { reason: 'moving', message: 'Your character is moving to another instance. Join again in a few seconds.' };
    else if (sync.away[uuid]) refused = { reason: 'away', message: `This character is on ${sync.away[uuid].toLabel || 'another instance'}. Join again to go there.` };
    if (refused) {
      sync.refusals.push({ uuid, ...refused, at: Date.now() });
      return { ok: false, refused: refused.reason, message: refused.message };
    }
    sync.online.add(uuid);
    return { ok: true, presenceSent: sendPresence('join', [presencePlayer(uuid, true)]) };
  },
  quit(b) {
    const uuid = String(b.uuid).toLowerCase();
    if (!sync.online.delete(uuid)) return { ok: false, error: 'not online' };
    sync.dats[uuid] ??= { DataVersion: SYNC_DV, Inventory: [], XpLevel: 0, Health: 20 };
    const presenceSent = sendPresence('quit', [presencePlayer(uuid, false)]);
    shadowCapture(uuid);
    return { ok: true, presenceSent };
  },
  fault(b) {
    if (b.reset) sync.faults = {};
    for (const [k, v] of Object.entries(b)) {
      if (k === 'reset') continue;
      if (v && typeof v === 'object' && !Array.isArray(v) && k !== 'disconnectAfter') sync.faults[k] = { ...(sync.faults[k] ?? {}), ...v };
      else sync.faults[k] = v;
    }
    return { ok: true, faults: sync.faults };
  },
  disconnect(b) {
    dropLink(b.holdDown !== false);
    return { ok: true };
  },
  reconnect(b) {
    if (typeof b.fp === 'string' && b.fp) SYNC_FP = b.fp;
    sync.holdDown = false;
    // The old session counts as gone at once. A caller that waits for `registered` then waits
    // for the new session, also when the close event of the old one comes late.
    sync.registered = false;
    if (currentWs && currentWs.readyState <= WebSocket.OPEN) currentWs.close();
    else connect();
    return { ok: true, fp: SYNC_FP };
  },
  /** Valhalla-Updater restored this instance from a backup: stamps and local marks roll back. */
  restore(b) {
    const rolled = [];
    for (const [u, stamp] of Object.entries(b.stamps ?? {})) {
      const dat = sync.dats[u.toLowerCase()];
      if (!dat) continue;
      if (stamp) setStamp(dat, clone(stamp));
      else if (dat.NeoForgeData?.PlayerPersisted) delete dat.NeoForgeData.PlayerPersisted.biforesting_sync;
      rolled.push(u.toLowerCase());
    }
    for (const u of b.dropAway ?? []) delete sync.away[String(u).toLowerCase()];
    for (const u of b.dropMoving ?? []) delete sync.moving[String(u).toLowerCase()];
    const back = { ...(b.away ?? {}) };
    for (const [u, mark] of Object.entries(back)) sync.away[u.toLowerCase()] = { at: Date.now(), ...clone(mark) };
    for (const [u, moveId] of Object.entries(b.moving ?? {})) sync.moving[u.toLowerCase()] = String(moveId);
    for (const [h, recs] of Object.entries(b.worldData ?? {})) {
      sync.worldData[h] ??= {};
      Object.assign(sync.worldData[h], clone(recs));
    }
    for (const [lk, lock] of Object.entries(b.locks ?? {})) {
      if (lock) sync.locks[lk] = clone(lock);
      else delete sync.locks[lk];
    }
    console.log(
      `[fake-mod] restore: ${rolled.length} stamp(s) rolled back, ${(b.dropAway ?? []).length} away and ${(b.dropMoving ?? []).length} moving mark(s) dropped, ` +
        `${Object.keys(back).length} away and ${Object.keys(b.moving ?? {}).length} moving mark(s) back`,
    );
    return { ok: true, rolled };
  },
  /** The open check of spec 3.7: the refusal text, or null when the record opens. */
  open(b) {
    const l = sync.locks[`${b.h}:${b.key}`];
    if (!sync.worldData[b.h]?.[b.key]) return { exists: false, refused: null };
    const label = l?.toLabel || l?.to || 'another instance';
    let refused = null;
    if (l?.state === 'out') refused = `This storage is moving to ${label} right now.`;
    else if (l?.state === 'tombstone' && l.until > Date.now()) refused = `This storage moved to ${label}.`;
    else if (l?.state === 'foreign') refused = `This storage is on ${label}.`;
    return { exists: true, refused };
  },
};

function startControl(controlPort) {
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let out;
      let status = 200;
      try {
        const name = (req.url ?? '/').replace(/^\//, '').split('?')[0];
        if (req.method === 'GET' && name === 'state') out = syncState();
        else if (req.method === 'POST' && Object.hasOwn(control, name)) out = control[name](body ? JSON.parse(body) : {});
        else {
          status = 404;
          out = { error: `no route ${req.method} ${req.url}` };
        }
      } catch (e) {
        status = 500;
        out = { error: e.message };
      }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  srv.listen(controlPort, '127.0.0.1', () => console.log(`[fake-mod] control on 127.0.0.1:${controlPort}`));
}

// ── connection ───────────────────────────────────────────────────────────────

function onOpen(sock) {
  console.log(`[fake-mod] connected (ws) to ${host}:${port} as serverId="${serverId}"${process.env.BAD_KEY ? ' (BAD_KEY — expect rejection)' : ''}`);
  sendUnit(sock, 'biforesting:hello', Buffer.from(serverId, 'utf8'));
  sendUnit(sock, 'biforesting:register', register());
  if (SYNC_MODE) {
    // The mod reports who is online at link-up, with stamps (spec 3.3).
    sendPresence('snapshot', [...sync.online].map((u) => presencePlayer(u, true)));
    sendUnit(sock, 'biforesting:metrics', metrics());
    return;
  }
  sendUnit(sock, 'biforesting:registry', registry());
  if (process.env.SEND_PRESENCE) {
    sendUnit(sock, 'biforesting:presence', jsonPayload({
      event: 'snapshot',
      online: [{ uuid: '00000000-0000-0000-0000-000000000001', name: 'TestPlayer' }],
    }));
  }
  if (process.env.SEND_QUEST) sendUnit(sock, 'biforesting:quest', quest());
  if (process.env.SEND_CHUNKS) sendUnit(sock, 'biforesting:chunks', chunks());
  if (process.env.SEND_INVSNAP) {
    // [ver=1][utf json header][varint gzLen][gz] — gz bytes are opaque to yggdrasil
    const header = utf(JSON.stringify({
      uuid: '00000000-0000-0000-0000-000000000001',
      name: 'TestPlayer',
      reason: 'join',
      dim: 'minecraft:overworld',
      pos: [1.5, 64, -3.25],
      dataVersion: 3955,
      items: [{ slot: 0, id: 'minecraft:diamond', count: 12 }, { slot: 100, id: 'minecraft:ender_pearl', count: 3 }],
    }));
    const gz = Buffer.from([31, 139, 8, 0, 1, 2, 3, 4]);
    sendUnit(sock, 'biforesting:invsnap', Buffer.concat([vint(1), header, vint(gz.length), gz]));
  }
  if (process.env.SEND_SPIKE) sendUnit(sock, 'biforesting:spike', spikePayload());
  if (process.env.SEND_SYNC) sendUnit(sock, 'biforesting:syncsnap', syncSnap());
  if (process.env.SEND_QUESTREG) {
    // [ver=1][varint gzLen][gz utf8-json] — mirrors shared QuestRegistryPayloads (phase 6)
    const gz = gzipSync(Buffer.from(JSON.stringify({
      source: 'ftbq',
      count: 2,
      quests: [
        { id: '00000000000001A4', chapter: '1', chapterTitle: 'Getting Started', title: 'Craft a Furnace', subtitle: 'smelt things', taskCount: 1, tasks: ['ItemTask'] },
        { id: '00000000000001A5', chapter: '1', chapterTitle: 'Getting Started', title: 'Advanced Circuits', subtitle: '', taskCount: 0, tasks: [] },
      ],
    }), 'utf8'));
    sendUnit(sock, 'biforesting:questreg', Buffer.concat([vint(1), vint(gz.length), gz]));
  }
  sendUnit(sock, 'biforesting:metrics', metrics());
  setInterval(() => sendUnit(sock, 'biforesting:metrics', metrics()), 1000);
}

let currentWs = null;
let reconnectTimer = null;

/** Drop the link. With holdDown, the sync mode waits for POST /reconnect. */
function dropLink(holdDown) {
  sync.holdDown = holdDown;
  if (currentWs) currentWs.terminate();
}

function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const ws = new WebSocket(`ws://${host}:${port}/biforesting/`);
  currentWs = ws;
  inbuf = Buffer.alloc(0);
  inflight.clear();
  transport.send = (unit) => {
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(unit, { binary: true });
    return true;
  };
  ws.on('open', () => {
    sync.connected = true;
    sync.connects++;
    onOpen(ws);
  });
  // Each WS message is one complete outer unit; the incremental parser handles it fine.
  ws.on('message', (raw) => onData(Buffer.isBuffer(raw) ? raw : Buffer.from(raw)));
  ws.on('error', (e) => console.error('[fake-mod] error:', e.message));
  ws.on('close', () => {
    console.log('[fake-mod] closed');
    if (!SYNC_MODE) process.exit(0);
    if (currentWs !== ws) return;
    sync.connected = false;
    sync.registered = false;
    transport.send = null;
    if (!sync.holdDown) reconnectTimer = setTimeout(connect, 1000);
  });
}

if (SYNC_MODE) {
  if (flags['--control-port']) startControl(Number(flags['--control-port']));
  setInterval(() => sendUnit(null, 'biforesting:metrics', metrics()), 5000).unref();
}
connect();
