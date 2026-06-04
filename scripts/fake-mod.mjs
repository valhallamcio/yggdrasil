#!/usr/bin/env node
/**
 * Fake Biforesting backend — a *client* emulator for the Yggdrasil play-phase link.
 *
 * The mod is the client and Yggdrasil the server, so `bifrost-lib/test/ygg_mock.py` (a listener)
 * can't drive Yggdrasil. This connects to a running Yggdrasil, sends a signed `hello` + periodic
 * `metrics` + a one-time `registry` (+ optional `quest`/`chunks`), and prints any DOWN frames it
 * receives. Mirrors `YggdrasilLink.java` framing and `PlayFrameCodec.java` signing.
 *
 *   BIFORESTING_PSK=<psk> node scripts/fake-mod.mjs [host] [port] [serverId]
 *   BIFORESTING_AUTHKEY_HEX=<64hex> node scripts/fake-mod.mjs 127.0.0.1 8765 my-server
 *
 * Flags via env: SEND_QUEST=1 SEND_CHUNKS=1 BAD_KEY=1 (sign with a wrong key → all frames rejected).
 */
import net from 'node:net';
import { createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

const host = process.argv[2] ?? '127.0.0.1';
const port = Number(process.argv[3] ?? 8765);
const serverId = process.argv[4] ?? 'test';

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
function sendUnit(sock, channel, payload) {
  const frame = signFrame(channel, payload);
  const ch = Buffer.from(channel, 'utf8');
  const head = Buffer.alloc(2 + ch.length + 4);
  head.writeUInt16BE(ch.length, 0);
  ch.copy(head, 2);
  head.writeInt32BE(frame.length, 2 + ch.length);
  sock.write(Buffer.concat([head, frame]));
}

// ── payload builders ─────────────────────────────────────────────────────────
const metrics = () =>
  Buffer.concat([vint(1), f32(45 + Math.random() * 5), f32(20), vint(0), vint(3), vint(900), i64(120 * 1024 * 1024), i64(512 * 1024 * 1024)]);
const registry = () =>
  Buffer.concat([vint(1), vint(3), utf('minecraft:dirt'), vint(9), utf('minecraft:stone'), vint(1), utf('create:cogwheel'), vint(7777)]);
const quest = () =>
  Buffer.concat([vint(1), vint(1), utf('11111111-2222-3333-4444-555555555555'), vint(3700), utf('{progress:[I;1,2,3]}')]);
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
  }
}

const sock = net.createConnection({ host, port }, () => {
  console.log(`[fake-mod] connected to ${host}:${port} as serverId="${serverId}"${process.env.BAD_KEY ? ' (BAD_KEY — expect rejection)' : ''}`);
  sendUnit(sock, 'biforesting:hello', Buffer.from(serverId, 'utf8'));
  sendUnit(sock, 'biforesting:registry', registry());
  if (process.env.SEND_QUEST) sendUnit(sock, 'biforesting:quest', quest());
  if (process.env.SEND_CHUNKS) sendUnit(sock, 'biforesting:chunks', chunks());
  sendUnit(sock, 'biforesting:metrics', metrics());
  setInterval(() => sendUnit(sock, 'biforesting:metrics', metrics()), 1000);
});
sock.on('data', onData);
sock.on('error', (e) => console.error('[fake-mod] error:', e.message));
sock.on('close', () => { console.log('[fake-mod] closed'); process.exit(0); });
