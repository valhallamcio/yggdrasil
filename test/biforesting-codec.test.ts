import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';

import {
  decodeFrame,
  encodeFrames,
  encodeOuterUnit,
  parseOuterUnits,
  parseSingleOuterUnit,
  Reassembler,
} from '../src/plugins/biforesting-link/frame-codec.ts';
import {
  decodeMetrics,
  decodeRegistry,
  decodeQuest,
  decodeChunks,
  encodeQuestDown,
  encodeChunksDown,
  decodeRegister,
  encodeRegAck,
} from '../src/plugins/biforesting-link/decoders.ts';
import { Reader } from '../src/plugins/biforesting-link/frame-codec.ts';

// ── Independent wire helpers (do NOT reuse the code under test) ───────────────

function vint(n: number): Buffer {
  const out: number[] = [];
  let v = n >>> 0;
  for (;;) {
    const b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) out.push(b | 0x80);
    else {
      out.push(b);
      break;
    }
  }
  return Buffer.from(out);
}
function utf(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([vint(b.length), b]);
}
function i64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(n);
  return b;
}
function f32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeFloatBE(n);
  return b;
}

/** Hand-build a frame exactly per the spec's MAC formula (the ground-truth cross-check). */
function buildFrame(
  channel: string,
  messageId: number,
  seq: number,
  total: number,
  ts: number,
  nonce: bigint,
  chunk: Buffer,
  authKey: Buffer,
  version = 1,
): Buffer {
  const ch = Buffer.from(channel, 'utf8');
  const macInput = Buffer.concat([
    vint(ch.length),
    ch,
    vint(messageId),
    vint(seq),
    vint(total),
    i64(BigInt(ts)),
    i64(nonce),
    chunk,
  ]);
  const sig = createHmac('sha256', authKey).update(macInput).digest();
  return Buffer.concat([
    vint(version),
    vint(messageId),
    vint(seq),
    vint(total),
    i64(BigInt(ts)),
    i64(nonce),
    vint(chunk.length),
    chunk,
    sig,
  ]);
}

const KEY = randomBytes(32);
const CH = 'biforesting:metrics';

// ── Frame codec ──────────────────────────────────────────────────────────────

test('decodeFrame accepts a hand-built frame and extracts the exact fields', () => {
  const now = Date.now();
  const chunk = Buffer.from('payload-bytes');
  const frame = buildFrame(CH, 1234, 0, 1, now, 99n, chunk, KEY);
  const decoded = decodeFrame(CH, frame, now, KEY);
  assert.ok(decoded);
  assert.equal(decoded.messageId, 1234);
  assert.equal(decoded.seq, 0);
  assert.equal(decoded.total, 1);
  assert.deepEqual(decoded.payload, chunk);
});

test('decodeFrame rejects a tampered HMAC', () => {
  const now = Date.now();
  const frame = buildFrame(CH, 1, 0, 1, now, 1n, Buffer.from('x'), KEY);
  frame[frame.length - 1] ^= 0xff; // flip last byte of the signature
  assert.equal(decodeFrame(CH, frame, now, KEY), null);
});

test('decodeFrame rejects a frame signed with the wrong channel (channel binding)', () => {
  const now = Date.now();
  const frame = buildFrame(CH, 1, 0, 1, now, 1n, Buffer.from('x'), KEY);
  assert.equal(decodeFrame('biforesting:quest', frame, now, KEY), null);
});

test('decodeFrame rejects wrong protocol version', () => {
  const now = Date.now();
  const frame = buildFrame(CH, 1, 0, 1, now, 1n, Buffer.from('x'), KEY, 2);
  assert.equal(decodeFrame(CH, frame, now, KEY), null);
});

test('decodeFrame rejects out-of-range total/seq', () => {
  const now = Date.now();
  assert.equal(decodeFrame(CH, buildFrame(CH, 1, 0, 0, now, 1n, Buffer.from('x'), KEY), now, KEY), null);
  assert.equal(decodeFrame(CH, buildFrame(CH, 1, 3, 2, now, 1n, Buffer.from('x'), KEY), now, KEY), null);
});

test('decodeFrame rejects a stale timestamp (>30s)', () => {
  const now = Date.now();
  const frame = buildFrame(CH, 1, 0, 1, now - 60_000, 1n, Buffer.from('x'), KEY);
  assert.equal(decodeFrame(CH, frame, now, KEY), null);
});

test('encodeFrames → decodeFrame round-trips a single chunk', () => {
  const now = Date.now();
  const payload = Buffer.from('round-trip');
  const frames = encodeFrames(CH, 7, payload, now, KEY);
  assert.equal(frames.length, 1);
  const decoded = decodeFrame(CH, frames[0]!, now, KEY);
  assert.ok(decoded);
  assert.deepEqual(decoded.payload, payload);
});

test('encodeFrames chunks large payloads; Reassembler rebuilds the original', () => {
  const now = Date.now();
  const payload = randomBytes(50);
  const frames = encodeFrames(CH, 42, payload, now, KEY, 8); // 8-byte chunks → 7 frames
  assert.equal(frames.length, Math.ceil(50 / 8));
  const r = new Reassembler();
  let full: Buffer | null = null;
  for (const f of frames) {
    const decoded = decodeFrame(CH, f, now, KEY);
    assert.ok(decoded);
    const out = r.add(CH, decoded);
    if (out) full = out;
  }
  assert.ok(full);
  assert.deepEqual(full, payload);
});

test('parseOuterUnits handles TCP fragmentation across two reads', () => {
  const a = encodeOuterUnit('biforesting:hello', Buffer.from('frame-a'));
  const b = encodeOuterUnit(CH, Buffer.from('frame-b'));
  const wire = Buffer.concat([a, b]);
  const splitAt = a.length + 3; // mid-way through the second unit

  const first = parseOuterUnits(wire.subarray(0, splitAt));
  assert.equal(first.units.length, 1);
  assert.equal(first.units[0]!.channel, 'biforesting:hello');
  assert.deepEqual(first.units[0]!.frame, Buffer.from('frame-a'));

  const second = parseOuterUnits(Buffer.concat([first.rest, wire.subarray(splitAt)]));
  assert.equal(second.units.length, 1);
  assert.equal(second.units[0]!.channel, CH);
  assert.deepEqual(second.units[0]!.frame, Buffer.from('frame-b'));
});

// ── Single-unit parse (WebSocket transport: one message == one outer unit) ────

test('parseSingleOuterUnit parses exactly one unit from a self-contained WS message', () => {
  const wire = encodeOuterUnit(CH, Buffer.from('frame-bytes'));
  const unit = parseSingleOuterUnit(wire);
  assert.equal(unit.channel, CH);
  assert.deepEqual(unit.frame, Buffer.from('frame-bytes'));
});

test('parseSingleOuterUnit round-trips a real signed frame (channel binding survives)', () => {
  const now = Date.now();
  const [frame] = encodeFrames(CH, 5, Buffer.from('payload'), now, KEY);
  const unit = parseSingleOuterUnit(encodeOuterUnit(CH, frame!));
  const decoded = decodeFrame(unit.channel, unit.frame, now, KEY);
  assert.ok(decoded);
  assert.deepEqual(decoded.payload, Buffer.from('payload'));
});

test('parseSingleOuterUnit rejects a truncated header', () => {
  assert.throws(() => parseSingleOuterUnit(Buffer.from([0x00])));
  const wire = encodeOuterUnit(CH, Buffer.from('x'));
  assert.throws(() => parseSingleOuterUnit(wire.subarray(0, 3))); // mid-channel
});

test('parseSingleOuterUnit rejects a frame body shorter than frameLen', () => {
  const wire = encodeOuterUnit(CH, Buffer.from('full-frame'));
  assert.throws(() => parseSingleOuterUnit(wire.subarray(0, wire.length - 2)));
});

test('parseSingleOuterUnit rejects trailing bytes after the unit (must be exactly one)', () => {
  const two = Buffer.concat([encodeOuterUnit(CH, Buffer.from('a')), encodeOuterUnit(CH, Buffer.from('b'))]);
  assert.throws(() => parseSingleOuterUnit(two), /trailing/);
});

// ── Payload decoders (field order pinned to ygg_mock.py) ──────────────────────

test('decodeMetrics reads mspt/tps/players/levels/chunks/heap in order', () => {
  const payload = Buffer.concat([
    vint(1),
    f32(48.5),
    f32(20.0),
    vint(7),
    vint(3),
    vint(1234),
    i64(100n * 1024n * 1024n),
    i64(512n * 1024n * 1024n),
  ]);
  const m = decodeMetrics(payload);
  assert.ok(Math.abs(m.mspt - 48.5) < 0.01);
  assert.ok(Math.abs(m.tps - 20.0) < 0.01);
  assert.equal(m.players, 7);
  assert.equal(m.levels, 3);
  assert.equal(m.loadedChunks, 1234);
  assert.equal(m.heapUsed, 100 * 1024 * 1024);
  assert.equal(m.heapMax, 512 * 1024 * 1024);
});

test('decodeRegistry reads count then id→numericId pairs', () => {
  const payload = Buffer.concat([
    vint(1),
    vint(2),
    utf('minecraft:dirt'),
    vint(9),
    utf('minecraft:stone'),
    vint(1),
  ]);
  const reg = decodeRegistry(payload);
  assert.equal(reg.count, 2);
  assert.deepEqual(reg.entries, [
    { id: 'minecraft:dirt', numericId: 9 },
    { id: 'minecraft:stone', numericId: 1 },
  ]);
});

test('decodeQuest reads teamId/dataVersion/snbt per team', () => {
  const payload = Buffer.concat([
    vint(1),
    vint(1),
    utf('11111111-2222-3333-4444-555555555555'),
    vint(3700),
    utf('{progress:1b}'),
  ]);
  const teams = decodeQuest(payload);
  assert.equal(teams.length, 1);
  assert.equal(teams[0]!.teamId, '11111111-2222-3333-4444-555555555555');
  assert.equal(teams[0]!.dataVersion, 3700);
  assert.equal(teams[0]!.snbt, '{progress:1b}');
});

test('decodeChunks reads claims with dimension/x/z/force', () => {
  const payload = Buffer.concat([
    vint(1),
    vint(1),
    utf('team-a'),
    vint(2),
    utf('minecraft:overworld'),
    vint(10),
    vint(20),
    Buffer.from([1]),
    utf('minecraft:the_nether'),
    vint(0),
    vint(0),
    Buffer.from([0]),
  ]);
  const teams = decodeChunks(payload);
  assert.equal(teams.length, 1);
  assert.equal(teams[0]!.claims.length, 2);
  assert.deepEqual(teams[0]!.claims[0], { dimension: 'minecraft:overworld', x: 10, z: 20, force: true });
  assert.deepEqual(teams[0]!.claims[1], { dimension: 'minecraft:the_nether', x: 0, z: 0, force: false });
});

// ── DOWN encoders round-trip through the UP decoders ─────────────────────────

test('encodeQuestDown round-trips through decodeQuest', () => {
  const teams = [{ teamId: 'team-x', dataVersion: 3465, snbt: '{a:1b,b:"two"}' }];
  assert.deepEqual(decodeQuest(encodeQuestDown(teams)), teams);
});

// ── Register handshake codec ─────────────────────────────────────────────────

test('decodeRegister reads ver/serverId/hint/caps/node/gameAddr/bootNonce in order', () => {
  const bootNonce = 0x7fffffffffffffffn; // beyond JS safe-int range
  const payload = Buffer.concat([
    vint(1),
    utf('ptero-abc123'),
    utf('Sky Factory'),
    vint(0x3f0),
    utf('node-eu-1'),
    utf('play.example.com:25565'),
    i64(bootNonce),
  ]);
  const reg = decodeRegister(payload);
  assert.equal(reg.serverId, 'ptero-abc123');
  assert.equal(reg.friendlyHint, 'Sky Factory');
  assert.equal(reg.capabilities, 0x3f0);
  assert.equal(reg.node, 'node-eu-1');
  assert.equal(reg.gameAddr, 'play.example.com:25565');
  assert.equal(reg.bootNonce, bootNonce.toString()); // kept as string, not coerced to Number
});

test('encodeRegAck writes ver/byte-accepted/ids/hz/serverTime in the exact layout', () => {
  const now = Date.now();
  const buf = encodeRegAck({
    accepted: true,
    canonicalServerId: 'ptero-abc123',
    friendlyName: 'Sky Factory',
    enabledFeatures: 0x3f0,
    metricsHz: 1,
    questHz: 1,
    chunkHz: 1,
    serverTimeMillis: now,
  });
  const r = new Reader(buf);
  assert.equal(r.varInt(), 1); // version
  assert.equal(r.byte(), 1); // accepted is a plain 0/1 byte, NOT a varint
  assert.equal(r.utf(), 'ptero-abc123');
  assert.equal(r.utf(), 'Sky Factory');
  assert.equal(r.varInt(), 0x3f0);
  assert.equal(r.varInt(), 1);
  assert.equal(r.varInt(), 1);
  assert.equal(r.varInt(), 1);
  assert.equal(r.long(), BigInt(now));
});

test('encodeRegAck writes accepted=0 as a single zero byte', () => {
  const buf = encodeRegAck({
    accepted: false,
    canonicalServerId: 'raw-id',
    friendlyName: '',
    enabledFeatures: 0x3f0,
    metricsHz: 1,
    questHz: 1,
    chunkHz: 1,
    serverTimeMillis: 0,
  });
  const r = new Reader(buf);
  assert.equal(r.varInt(), 1);
  assert.equal(r.byte(), 0);
  assert.equal(r.utf(), 'raw-id');
  assert.equal(r.utf(), '');
});

test('encodeChunksDown round-trips through decodeChunks', () => {
  const teams = [
    {
      teamId: 'team-y',
      claims: [
        { dimension: 'minecraft:overworld', x: -5, z: 7, force: true },
        { dimension: 'minecraft:overworld', x: -5, z: 8, force: false },
      ],
    },
  ];
  assert.deepEqual(decodeChunks(encodeChunksDown(teams)), teams);
});
