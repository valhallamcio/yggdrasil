import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Pure codec for the Biforesting play-phase link, mirroring the mod's
 * `PlayFrameCodec.java` / `YggdrasilLink.java` byte-for-byte.
 *
 * Frame: [ver varint=1][messageId varint][seq varint][total varint]
 *        [timestamp int64 BE][nonce int64 BE][chunkLen varint][chunk][hmac 32B]
 *
 * Outer wire (one unit on the socket, Java DataOutputStream):
 *        [channel: uint16 BE len + UTF-8][frameLen: int32 BE][frame: frameLen bytes]
 *
 * HMAC-SHA256 MAC input (binds the channel; excludes `ver` and `chunkLen`):
 *   varint(len(chUtf8)) || chUtf8 || varint(messageId) || varint(seq)
 *     || varint(total) || int64BE(ts) || int64BE(nonce) || chunk
 */

export const PLAY_PROTOCOL_VERSION = 1;
export const REPLAY_WINDOW_MS = 30_000;
export const MAX_CHUNKS = 8192;
export const DEFAULT_MAX_CHUNK = 24 * 1024;
export const SIG_LEN = 32;

/** Bound on concurrent incomplete reassembly buffers per connection. */
export const MAX_INFLIGHT_MESSAGES = 64;
/** Bound on one message's total reassembled bytes. */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/** Hard cap on a single outer frame's declared length (matches the mod's MAX_INBOUND_FRAME). */
export const MAX_INBOUND_FRAME = 8 * 1024 * 1024;

// ── VarInt (LEB128, 7 bits/byte, max 5 bytes for a 32-bit value) ─────────────

export function readVarInt(buf: Buffer, offset: number): { value: number; size: number } {
  let value = 0;
  let pos = 0;
  let size = 0;
  for (;;) {
    const b = buf.readUInt8(offset + size);
    size += 1;
    value |= (b & 0x7f) << pos;
    if ((b & 0x80) === 0) break;
    pos += 7;
    if (pos >= 35) throw new Error('VarInt too long');
  }
  // `value |= ...` already coerces to a signed 32-bit int (canonical MC VarInt).
  return { value, size };
}

export function writeVarInt(value: number): Buffer {
  const out: number[] = [];
  let v = value >>> 0; // treat as unsigned 32-bit, matching the mod's `v &= 0xFFFFFFFF`
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

// ── Stateful reader / writer for payload bodies ──────────────────────────────

export class Reader {
  private off = 0;
  constructor(private readonly buf: Buffer) {}

  varInt(): number {
    const { value, size } = readVarInt(this.buf, this.off);
    this.off += size;
    return value;
  }

  /** MC writeUtf: varint(byteLen) + UTF-8 bytes. */
  utf(): string {
    const len = this.varInt();
    const s = this.buf.toString('utf8', this.off, this.off + len);
    this.off += len;
    return s;
  }

  float(): number {
    const v = this.buf.readFloatBE(this.off);
    this.off += 4;
    return v;
  }

  double(): number {
    const v = this.buf.readDoubleBE(this.off);
    this.off += 8;
    return v;
  }

  long(): bigint {
    const v = this.buf.readBigInt64BE(this.off);
    this.off += 8;
    return v;
  }

  byte(): number {
    const v = this.buf.readUInt8(this.off);
    this.off += 1;
    return v;
  }

  bool(): boolean {
    return this.byte() !== 0;
  }

  remaining(): number {
    return this.buf.length - this.off;
  }
}

export class Writer {
  private readonly parts: Buffer[] = [];

  varInt(v: number): this {
    this.parts.push(writeVarInt(v));
    return this;
  }

  /** MC writeUtf: varint(byteLen) + UTF-8 bytes. */
  utf(s: string): this {
    const b = Buffer.from(s, 'utf8');
    this.parts.push(writeVarInt(b.length), b);
    return this;
  }

  float(v: number): this {
    const b = Buffer.allocUnsafe(4);
    b.writeFloatBE(v, 0);
    this.parts.push(b);
    return this;
  }

  double(v: number): this {
    const b = Buffer.allocUnsafe(8);
    b.writeDoubleBE(v, 0);
    this.parts.push(b);
    return this;
  }

  long(v: bigint): this {
    const b = Buffer.allocUnsafe(8);
    b.writeBigInt64BE(v, 0);
    this.parts.push(b);
    return this;
  }

  byte(v: number): this {
    this.parts.push(Buffer.from([v & 0xff]));
    return this;
  }

  bool(v: boolean): this {
    return this.byte(v ? 1 : 0);
  }

  build(): Buffer {
    return Buffer.concat(this.parts);
  }
}

// ── HMAC ─────────────────────────────────────────────────────────────────────

function macInput(
  channel: string,
  messageId: number,
  seq: number,
  total: number,
  timestamp: bigint,
  nonce: bigint,
  chunk: Buffer,
): Buffer {
  const ch = Buffer.from(channel, 'utf8');
  const ts = Buffer.allocUnsafe(8);
  ts.writeBigInt64BE(timestamp, 0);
  const nc = Buffer.allocUnsafe(8);
  nc.writeBigInt64BE(nonce, 0);
  return Buffer.concat([
    writeVarInt(ch.length),
    ch,
    writeVarInt(messageId),
    writeVarInt(seq),
    writeVarInt(total),
    ts,
    nc,
    chunk,
  ]);
}

function hmac(authKey: Buffer, input: Buffer): Buffer {
  return createHmac('sha256', authKey).update(input).digest();
}

// ── Frame decode / encode ────────────────────────────────────────────────────

export interface DecodedFrame {
  messageId: number;
  seq: number;
  total: number;
  timestamp: bigint;
  nonce: bigint;
  payload: Buffer;
}

/**
 * Decode + verify one frame. Returns null on any rule violation (fail-closed):
 * wrong version, out-of-range total/seq, negative chunkLen, stale timestamp,
 * or HMAC mismatch. Mirrors `PlayFrameCodec.decode`.
 */
export function decodeFrame(channel: string, frame: Buffer, now: number, authKey: Buffer): DecodedFrame | null {
  if (frame.length < 4 + 8 + 8 + 1 + SIG_LEN) return null;
  try {
    let off = 0;
    const ver = readVarInt(frame, off);
    off += ver.size;
    if (ver.value !== PLAY_PROTOCOL_VERSION) return null;

    const mid = readVarInt(frame, off);
    off += mid.size;
    const sq = readVarInt(frame, off);
    off += sq.size;
    const tot = readVarInt(frame, off);
    off += tot.size;
    if (tot.value < 1 || tot.value > MAX_CHUNKS || sq.value < 0 || sq.value >= tot.value) return null;

    const timestamp = frame.readBigInt64BE(off);
    off += 8;
    const nonce = frame.readBigInt64BE(off);
    off += 8;

    const cl = readVarInt(frame, off);
    off += cl.size;
    const chunkLen = cl.value;
    if (chunkLen < 0 || chunkLen > frame.length - off - SIG_LEN) return null;

    const chunk = frame.subarray(off, off + chunkLen);
    off += chunkLen;
    const sig = frame.subarray(off, off + SIG_LEN);

    if (Math.abs(now - Number(timestamp)) > REPLAY_WINDOW_MS) return null;

    const expected = hmac(authKey, macInput(channel, mid.value, sq.value, tot.value, timestamp, nonce, chunk));
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;

    return { messageId: mid.value, seq: sq.value, total: tot.value, timestamp, nonce, payload: Buffer.from(chunk) };
  } catch {
    return null;
  }
}

/** Encode a payload into one or more signed frames (for DOWN). Mirrors `PlayFrameCodec.encode`. */
export function encodeFrames(
  channel: string,
  messageId: number,
  payload: Buffer,
  timestamp: number,
  authKey: Buffer,
  maxChunk = DEFAULT_MAX_CHUNK,
): Buffer[] {
  const max = maxChunk > 0 ? maxChunk : DEFAULT_MAX_CHUNK;
  const total = Math.max(1, Math.ceil(payload.length / max));
  const ts = BigInt(timestamp);
  const frames: Buffer[] = [];
  for (let seq = 0; seq < total; seq++) {
    const chunk = payload.subarray(seq * max, Math.min(seq * max + max, payload.length));
    const nonce = randomBytes(8).readBigInt64BE(0);
    const sig = hmac(authKey, macInput(channel, messageId, seq, total, ts, nonce, chunk));
    const tsBuf = Buffer.allocUnsafe(8);
    tsBuf.writeBigInt64BE(ts, 0);
    const ncBuf = Buffer.allocUnsafe(8);
    ncBuf.writeBigInt64BE(nonce, 0);
    frames.push(
      Buffer.concat([
        writeVarInt(PLAY_PROTOCOL_VERSION),
        writeVarInt(messageId),
        writeVarInt(seq),
        writeVarInt(total),
        tsBuf,
        ncBuf,
        writeVarInt(chunk.length),
        chunk,
        sig,
      ]),
    );
  }
  return frames;
}

// ── Outer framing ────────────────────────────────────────────────────────────

/** Wrap one frame in the outer `[channel][frameLen][frame]` unit. */
export function encodeOuterUnit(channel: string, frame: Buffer): Buffer {
  const ch = Buffer.from(channel, 'utf8'); // channels are ASCII → modified-UTF-8 == UTF-8
  const head = Buffer.allocUnsafe(2 + ch.length + 4);
  head.writeUInt16BE(ch.length, 0);
  ch.copy(head, 2);
  head.writeInt32BE(frame.length, 2 + ch.length);
  return Buffer.concat([head, frame]);
}

export interface OuterUnit {
  channel: string;
  frame: Buffer;
}

/**
 * Parse as many complete `[channel][frameLen][frame]` units as are available in `buf`.
 * Returns the parsed units and the unconsumed remainder (for TCP fragmentation).
 * Throws if a declared frameLen is invalid (caller should drop the connection).
 */
export function parseOuterUnits(buf: Buffer): { units: OuterUnit[]; rest: Buffer } {
  const units: OuterUnit[] = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const chanLen = buf.readUInt16BE(off);
    if (buf.length - off < 2 + chanLen + 4) break;
    const channel = buf.toString('utf8', off + 2, off + 2 + chanLen);
    const frameLen = buf.readInt32BE(off + 2 + chanLen);
    if (frameLen < 0 || frameLen > MAX_INBOUND_FRAME) {
      throw new Error(`Invalid frameLen ${frameLen} on channel ${channel}`);
    }
    const unitEnd = off + 2 + chanLen + 4 + frameLen;
    if (buf.length < unitEnd) break;
    const frame = buf.subarray(off + 2 + chanLen + 4, unitEnd);
    units.push({ channel, frame: Buffer.from(frame) });
    off = unitEnd;
  }
  return { units, rest: off === 0 ? buf : buf.subarray(off) };
}

/**
 * Parse EXACTLY ONE `[channel][frameLen][frame]` outer unit from a self-contained message buffer.
 *
 * For the WebSocket transport the message boundary IS the unit boundary, so — unlike the TCP
 * `parseOuterUnits` stream parser — there is no fragmentation to carry over: the buffer must hold
 * one whole unit and nothing more. Throws on a truncated header, a bad/oversized `frameLen`, a short
 * frame body, or trailing bytes after the unit (caller should drop the connection). Reuses the same
 * `[uint16 BE chanLen][UTF-8 channel][int32 BE frameLen][frame]` layout `parseOuterUnits` consumes.
 */
export function parseSingleOuterUnit(buf: Buffer): OuterUnit {
  // Header is fixed-width big-endian (uint16 chanLen / int32 frameLen), matching `parseOuterUnits`.
  if (buf.length < 2) throw new Error('Outer unit truncated: missing channel length');
  const chanLen = buf.readUInt16BE(0);
  if (buf.length < 2 + chanLen + 4) throw new Error('Outer unit truncated: incomplete channel/frameLen');
  const channel = buf.toString('utf8', 2, 2 + chanLen);
  const frameLen = buf.readInt32BE(2 + chanLen);
  if (frameLen < 0 || frameLen > MAX_INBOUND_FRAME) {
    throw new Error(`Invalid frameLen ${frameLen} on channel ${channel}`);
  }
  const unitEnd = 2 + chanLen + 4 + frameLen;
  if (buf.length < unitEnd) throw new Error('Outer unit truncated: frame body shorter than frameLen');
  if (buf.length > unitEnd) throw new Error('Outer unit has trailing bytes (expected exactly one unit per message)');
  return { channel, frame: Buffer.from(buf.subarray(2 + chanLen + 4, unitEnd)) };
}

// ── Reassembly ───────────────────────────────────────────────────────────────

interface Partial {
  total: number;
  parts: (Buffer | null)[];
  received: number;
  receivedBytes: number;
}

/**
 * Per-connection reassembler keyed by `channel:messageId`. Returns the full payload when a
 * message is complete, else null. Mirrors `YggdrasilLink.Reassembler` bounds.
 */
export class Reassembler {
  private readonly inflight = new Map<string, Partial>();

  add(channel: string, frame: DecodedFrame): Buffer | null {
    if (frame.total <= 1) return frame.payload;

    const key = `${channel}:${frame.messageId}`;
    let p = this.inflight.get(key);
    if (p && p.total !== frame.total) {
      this.inflight.delete(key); // messageId reused with a different total: drop stale partial
      p = undefined;
    }
    if (!p) {
      if (this.inflight.size >= MAX_INFLIGHT_MESSAGES) this.inflight.clear();
      p = { total: frame.total, parts: new Array<Buffer | null>(frame.total).fill(null), received: 0, receivedBytes: 0 };
      this.inflight.set(key, p);
    }

    if (p.receivedBytes + frame.payload.length > MAX_MESSAGE_BYTES) {
      this.inflight.delete(key);
      return null;
    }
    if (frame.seq < 0 || frame.seq >= p.total || p.parts[frame.seq] !== null) return null;

    p.parts[frame.seq] = frame.payload;
    p.receivedBytes += frame.payload.length;
    p.received += 1;
    if (p.received !== p.total) return null;

    this.inflight.delete(key);
    return Buffer.concat(p.parts as Buffer[]);
  }
}
