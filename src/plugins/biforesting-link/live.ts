import { Reader, Writer } from './frame-codec.js';
import { FEATURE_BITS } from './policy-store.js';

/**
 * `biforesting:live`: a generic event bus between a backend mod and the Bifrost proxy. Yggdrasil
 * only relays it. The bus is non-durable: no queue, no retry, no journal. A frame for a down link,
 * a missing proxy or an off policy bit is dropped and counted.
 *
 * Payload: `[varint 1][utf json]`, JSON = `{"t": topic, "p": player uuid or "", "d": object}`.
 * MUST mirror the mod's shared `LiveBus` codec (bifrost-lib `shared/live/`).
 */

export const LIVE_CHANNEL = 'biforesting:live';
export const LIVE_VERSION = 1;
export const LIVE_FEATURE_BIT = FEATURE_BITS['live']!;
/** Cap on the encoded payload. The mod drops bigger frames on send and on receive too. */
export const LIVE_MAX_PAYLOAD = 16 * 1024;
export const LIVE_MAX_TOPIC = 128;
/**
 * Per-session UP rate cap, as a token bucket: 20 frames/s sustained, bursts up to 40. Event
 * traffic (encounters, scares) is a few frames per minute. The cap stops a bad handler loop on
 * one server from flooding the proxy.
 */
export const LIVE_UP_RATE_PER_SEC = 20;
export const LIVE_UP_BURST = 40;

const TOPIC_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LiveMsg {
  topic: string;
  /** Player uuid, or null for a server-wide frame (`""` on the wire). */
  player: string | null;
  data: Record<string, unknown>;
}

/** `live.up` body sent to the Bifrost proxy. */
export interface LiveUpMsg extends LiveMsg {
  instanceKey: string;
  serverId: string | null;
  tag: string | null;
  /** Receive time, epoch ms. */
  at: number;
}

export type LiveDropReason =
  | 'unresolved'
  | 'bit_off'
  | 'oversize'
  | 'rate'
  | 'malformed'
  | 'no_proxy'
  | 'unknown_server'
  | 'not_writable';

export interface LiveStats {
  up: number;
  down: number;
  dropped: Record<LiveDropReason, number>;
}

export function emptyLiveStats(): LiveStats {
  return {
    up: 0,
    down: 0,
    dropped: {
      unresolved: 0,
      bit_off: 0,
      oversize: 0,
      rate: 0,
      malformed: 0,
      no_proxy: 0,
      unknown_server: 0,
      not_writable: 0,
    },
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate the three message fields. Null when any field is bad. */
export function toLiveMsg(topic: unknown, player: unknown, data: unknown): LiveMsg | null {
  if (typeof topic !== 'string' || topic.length > LIVE_MAX_TOPIC || !TOPIC_RE.test(topic)) return null;
  let p: string | null;
  if (player === undefined || player === null || player === '') p = null;
  else if (typeof player === 'string' && UUID_RE.test(player)) p = player.toLowerCase();
  else return null;
  if (!isObject(data)) return null;
  return { topic, player: p, data };
}

export function encodeLive(msg: LiveMsg): Buffer {
  const json = JSON.stringify({ t: msg.topic, p: msg.player ?? '', d: msg.data });
  return new Writer().varInt(LIVE_VERSION).utf(json).build();
}

/** Throws on a bad version, bad JSON or a bad field. */
export function decodeLive(payload: Buffer): LiveMsg {
  const r = new Reader(payload);
  const ver = r.varInt();
  if (ver !== LIVE_VERSION) throw new Error(`live: unknown version ${ver}`);
  const raw = JSON.parse(r.utf()) as unknown;
  if (!isObject(raw)) throw new Error('live: payload is not a JSON object');
  const msg = toLiveMsg(raw['t'], raw['p'], raw['d']);
  if (!msg) throw new Error('live: bad topic, player or data');
  return msg;
}

/** `live.down` body from the Bifrost proxy: `{server, topic, player, data}`. Null when malformed. */
export function parseLiveDown(raw: unknown): { server: string; msg: LiveMsg } | null {
  if (!isObject(raw)) return null;
  const server = raw['server'];
  if (typeof server !== 'string' || server.length === 0) return null;
  const msg = toLiveMsg(raw['topic'], raw['player'], raw['data']);
  return msg ? { server, msg } : null;
}

/** Token bucket for the per-session UP rate cap. */
export class TokenBucket {
  private tokens: number;
  private at: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    now: number,
  ) {
    this.tokens = burst;
    this.at = now;
  }

  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + (Math.max(0, now - this.at) / 1000) * this.ratePerSec);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
