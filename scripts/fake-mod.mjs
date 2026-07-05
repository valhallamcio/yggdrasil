#!/usr/bin/env node
/**
 * Fake Biforesting backend — a *client* emulator for the Yggdrasil play-phase link.
 *
 * The mod is the client and Yggdrasil the server, so `bifrost-lib/test/ygg_mock.py` (a listener)
 * can't drive Yggdrasil. This connects to a running Yggdrasil, sends a signed `hello` + periodic
 * `metrics` + a one-time `registry` (+ optional `quest`/`chunks`), and prints any DOWN frames it
 * receives. Mirrors `YggdrasilLink.java` framing and `PlayFrameCodec.java` signing.
 *
 *   BIFORESTING_PSK=<psk> node scripts/fake-mod.mjs [host] [port] [serverId]          # raw TCP (deprecated listener)
 *   BIFORESTING_PSK=<psk> node scripts/fake-mod.mjs --ws [host] [port] [serverId]     # WS /biforesting/ on the main HTTP port
 *   BIFORESTING_AUTHKEY_HEX=<64hex> node scripts/fake-mod.mjs 127.0.0.1 8765 my-server
 *
 * WS mode mirrors the mod's WebSocketClient: one outer unit per binary message, default port 3000.
 * Flags via env: SEND_QUEST=1 SEND_CHUNKS=1 BAD_KEY=1 (sign with a wrong key → all frames rejected).
 *
 * Durable-ops emulation via `--op-mode <mode>` (how DOWN `biforesting:op` is answered):
 *   ack-ok    (default) ack, then a completed result — the happy path
 *   ack-drop  ack, never a result             → exercises the exec-timeout sweep
 *   drop      no response at all              → exercises the dispatch-timeout requeue
 *   dup       ack + result sent TWICE         → exercises store transition idempotency
 *   waiting   result status=waiting_player, then a presence join 2 s later; a re-dispatched
 *             op completes → exercises the waiting_player → presence → requeue path
 */
import net from 'node:net';
import { createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const useWs = args.includes('--ws');
const opModeIdx = args.indexOf('--op-mode');
const opMode = opModeIdx >= 0 ? args[opModeIdx + 1] : 'ack-ok';
const positional = args.filter((a, i) => a !== '--ws' && i !== opModeIdx && i !== opModeIdx + 1);
const host = positional[0] ?? '127.0.0.1';
const port = Number(positional[1] ?? (useWs ? 3000 : 8765));
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
const registry = () =>
  Buffer.concat([vint(1), vint(3), utf('minecraft:dirt'), vint(9), utf('minecraft:stone'), vint(1), utf('create:cogwheel'), vint(7777)]);
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

function onOpen(sock) {
  console.log(`[fake-mod] connected (${useWs ? 'ws' : 'tcp'}) to ${host}:${port} as serverId="${serverId}"${process.env.BAD_KEY ? ' (BAD_KEY — expect rejection)' : ''}`);
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
  sendUnit(sock, 'biforesting:metrics', metrics());
  setInterval(() => sendUnit(sock, 'biforesting:metrics', metrics()), 1000);
}

if (useWs) {
  const ws = new WebSocket(`ws://${host}:${port}/biforesting/`);
  transport.send = (unit) => ws.send(unit, { binary: true });
  ws.on('open', () => onOpen(ws));
  // Each WS message is one complete outer unit; the incremental parser handles it fine.
  ws.on('message', (raw) => onData(Buffer.isBuffer(raw) ? raw : Buffer.from(raw)));
  ws.on('error', (e) => console.error('[fake-mod] error:', e.message));
  ws.on('close', () => { console.log('[fake-mod] closed'); process.exit(0); });
} else {
  const sock = net.createConnection({ host, port }, () => onOpen(sock));
  transport.send = (unit) => sock.write(unit);
  sock.on('data', onData);
  sock.on('error', (e) => console.error('[fake-mod] error:', e.message));
  sock.on('close', () => { console.log('[fake-mod] closed'); process.exit(0); });
}
