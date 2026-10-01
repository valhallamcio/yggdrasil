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
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import WebSocket from 'ws';

const args = process.argv.slice(2);
// --ws kept as an accepted no-op so existing invocations keep working (WS is the only transport)
const opModeIdx = args.indexOf('--op-mode');
const opMode = opModeIdx >= 0 ? args[opModeIdx + 1] : 'ack-ok';
// NB: guard opModeIdx<0 — 'i !== opModeIdx + 1' would otherwise drop positional[0] when --op-mode is absent
const positional = args.filter((a, i) => a !== '--ws' && (opModeIdx < 0 || (i !== opModeIdx && i !== opModeIdx + 1)));
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
function signFrame(channel, payload) {
  const messageId = (++msgSeq) & 0x7fffffff;
  const seq = 0, total = 1;
  const ts = Date.now();
  const nonce = randomBytes(8).readBigInt64BE(0);
  const ch = Buffer.from(channel, 'utf8');
  const mac = Buffer.concat([vint(ch.length), ch, vint(messageId), vint(seq), vint(total), i64(ts), i64(nonce), payload]);
  const sig = createHmac('sha256', KEY).update(mac).digest();
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
// transport.send is set per-mode below: TCP streams the unit, WS sends it as one binary message.
const transport = { send: null };
function sendUnit(_sock, channel, payload) {
  transport.send(buildUnit(channel, payload));
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
const BOOT_NONCE = BigInt(Date.now()) * 1000n + BigInt(process.pid % 1000);
const register = () =>
  Buffer.concat([vint(2), utf(serverId), utf('fake-mod'), vint(Number(process.env.CAPS ?? 0x10)), utf('fake-node'), utf('127.0.0.1:25565'), i64(BOOT_NONCE), vint(2)]);
const chunks = () =>
  Buffer.concat([vint(1), vint(1), utf('11111111-2222-3333-4444-555555555555'), vint(1), utf('minecraft:overworld'), vint(0), vint(0), Buffer.from([1])]);

// ── minimal inbound (DOWN) printer ───────────────────────────────────────────
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
let inbuf = Buffer.alloc(0);
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
    // frame: ver,mid,seq,total,ts(8),nonce(8),chunkLen,chunk,sig(32)
    let o = 0;
    for (let i = 0; i < 4; i++) { const [, s] = readVar(frame, o); o += s; }
    o += 16;
    const [clen2, s2] = readVar(frame, o); o += s2;
    const chunk = frame.subarray(o, o + clen2);
    console.log(`[fake-mod] DOWN ${channel}: ${chunk.length}B payload`);
    if (channel === 'biforesting:op') onOp(chunk);
  }
}

// ── durable-ops emulation ────────────────────────────────────────────────────
const jsonPayload = (obj) => Buffer.concat([vint(1), utf(JSON.stringify(obj))]);
const seenOps = new Set(); // opIds already answered `waiting` (a re-dispatch completes)

function onOp(chunk) {
  // payload: [varint ver][utf json]
  let o = 0;
  const [, vs] = readVar(chunk, o); o += vs;           // ver
  const [slen, ss] = readVar(chunk, o); o += ss;       // utf length
  const op = JSON.parse(chunk.toString('utf8', o, o + slen));
  console.log(`[fake-mod] op ${op.opId} type=${op.type} mode=${opMode}`);
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

function onOpen(sock) {
  console.log(`[fake-mod] connected (ws) to ${host}:${port} as serverId="${serverId}"${process.env.BAD_KEY ? ' (BAD_KEY — expect rejection)' : ''}`);
  sendUnit(sock, 'biforesting:hello', Buffer.from(serverId, 'utf8'));
  sendUnit(sock, 'biforesting:register', register());
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

const ws = new WebSocket(`ws://${host}:${port}/biforesting/`);
transport.send = (unit) => ws.send(unit, { binary: true });
ws.on('open', () => onOpen(ws));
// Each WS message is one complete outer unit; the incremental parser handles it fine.
ws.on('message', (raw) => onData(Buffer.isBuffer(raw) ? raw : Buffer.from(raw)));
ws.on('error', (e) => console.error('[fake-mod] error:', e.message));
ws.on('close', () => { console.log('[fake-mod] closed'); process.exit(0); });
