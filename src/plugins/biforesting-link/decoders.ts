import { Reader, Writer } from './frame-codec.js';
import type { LinkMetrics, RegistryPayload, QuestTeam, ChunkTeam, RegisterInfo, RegAck, OpResMsg, PresenceMsg } from './types.js';

/**
 * Payload decoders/encoders for the four link channels. Field order mirrors
 * `bifrost-lib/test/ygg_mock.py` and `Bifrost/docs/biforesting-protocol.md` §5.
 * All payloads start with `[protocolVersion : varint] = 1`.
 */

// ── UP decoders ──────────────────────────────────────────────────────────────

export function decodeMetrics(payload: Buffer): LinkMetrics {
  const r = new Reader(payload);
  const version = r.varInt();
  if (version >= 2) {
    // v2: [varint 2][utf json] — global window + per-dim timing + census (plan D9/D13)
    const o = JSON.parse(r.utf()) as {
      msptAvg: number;
      msptMax: number;
      tps: number;
      players: number;
      heapUsed: number;
      heapMax: number;
      perDim: LinkMetrics['perDim'];
      censusAgeMs: number;
    };
    const perDim = Array.isArray(o.perDim) ? o.perDim : [];
    let loadedChunks = 0;
    for (const d of perDim) loadedChunks += d.loadedChunks || 0;
    return {
      mspt: o.msptAvg,
      tps: o.tps,
      players: o.players,
      levels: perDim.length,
      loadedChunks,
      heapUsed: o.heapUsed,
      heapMax: o.heapMax,
      v: version,
      msptMax: o.msptMax,
      perDim,
      censusAgeMs: o.censusAgeMs,
    };
  }
  const mspt = r.float();
  const tps = r.float();
  const players = r.varInt();
  const levels = r.varInt();
  const loadedChunks = r.varInt();
  const heapUsed = Number(r.long());
  const heapMax = Number(r.long());
  return { mspt, tps, players, levels, loadedChunks, heapUsed, heapMax };
}

export function decodeRegistry(payload: Buffer): RegistryPayload {
  const r = new Reader(payload);
  r.varInt(); // version
  const count = r.varInt();
  const entries = new Array<{ id: string; numericId: number }>(count);
  for (let i = 0; i < count; i++) {
    const id = r.utf();
    const numericId = r.varInt();
    entries[i] = { id, numericId };
  }
  return { count, entries };
}

export function decodeQuest(payload: Buffer): QuestTeam[] {
  const r = new Reader(payload);
  r.varInt(); // version
  const n = r.varInt();
  const teams = new Array<QuestTeam>(n);
  for (let i = 0; i < n; i++) {
    const teamId = r.utf();
    const dataVersion = r.varInt();
    const snbt = r.utf();
    teams[i] = { teamId, dataVersion, snbt };
  }
  return teams;
}

export function decodeChunks(payload: Buffer): ChunkTeam[] {
  const r = new Reader(payload);
  r.varInt(); // version
  const n = r.varInt();
  const teams = new Array<ChunkTeam>(n);
  for (let i = 0; i < n; i++) {
    const teamId = r.utf();
    const claimCount = r.varInt();
    const claims = new Array<{ dimension: string; x: number; z: number; force: boolean }>(claimCount);
    for (let j = 0; j < claimCount; j++) {
      const dimension = r.utf();
      const x = r.varInt();
      const z = r.varInt();
      const force = r.bool();
      claims[j] = { dimension, x, z, force };
    }
    teams[i] = { teamId, claims };
  }
  return teams;
}

/**
 * Decode `biforesting:register`:
 *   [varint ver=1][utf serverId][utf friendlyHint][varint capabilities]
 *   [utf node][utf gameAddr][int64 bootNonce]
 *
 * `bootNonce` is read as a BigInt (it may exceed JS safe-int range) and kept as a
 * string — never coerced to Number.
 */
export function decodeRegister(payload: Buffer): RegisterInfo {
  const r = new Reader(payload);
  const ver = r.varInt(); // message-format version: 1 (feat-era) or 2 (+linkProtocolVersion)
  const serverId = r.utf();
  const friendlyHint = r.utf();
  const capabilities = r.varInt();
  const node = r.utf();
  const gameAddr = r.utf();
  const bootNonce = r.long().toString();
  const linkProtocolVersion = ver >= 2 ? r.varInt() : 1;
  return { serverId, friendlyHint, capabilities, node, gameAddr, bootNonce, linkProtocolVersion };
}

// ── DOWN encoders (authoritative pushes) ─────────────────────────────────────

/**
 * Encode `biforesting:reg_ack` (v2):
 *   [varint ver=2][byte accepted(1/0)][utf canonicalServerId][utf friendlyName]
 *   [varint enabledFeatures][varint metricsHz][varint questHz][varint chunkHz][int64 serverTimeMillis]
 *   [varint negotiatedVersion]
 *
 * `accepted` is a plain 0/1 wire byte (NOT a varint). `serverTimeMillis` is written
 * as a big-endian int64. Always writes v2: feat-era (v1) mods reject a v2 ack and stay
 * unregistered — fine, none are deployed and they never enforced the policy anyway.
 */
export function encodeRegAck(ack: RegAck): Buffer {
  return new Writer()
    .varInt(2)
    .byte(ack.accepted ? 1 : 0)
    .utf(ack.canonicalServerId)
    .utf(ack.friendlyName)
    .varInt(ack.enabledFeatures)
    .varInt(ack.metricsHz)
    .varInt(ack.questHz)
    .varInt(ack.chunkHz)
    .long(BigInt(ack.serverTimeMillis))
    .varInt(ack.negotiatedVersion)
    .build();
}


// ── Ops + presence (JSON payloads per D7 — Gson mod-side, ≤20-char channels) ──

/**
 * `biforesting:op` (DOWN) and `biforesting:op_res` / `biforesting:presence` (UP) all share the
 * same envelope: `[varint ver=1][utf json]`. JSON keeps the op payload schema-free across the
 * four mod trees (Gson ships with MC on every target incl. 1.7.10).
 */
export function encodeJsonPayload(json: string): Buffer {
  return new Writer().varInt(1).utf(json).build();
}

export function decodeJsonPayload(payload: Buffer): unknown {
  const r = new Reader(payload);
  r.varInt(); // version
  return JSON.parse(r.utf());
}

export function decodeOpRes(payload: Buffer): OpResMsg {
  const raw = decodeJsonPayload(payload) as Record<string, unknown>;
  if (typeof raw['opId'] !== 'string' || (raw['phase'] !== 'ack' && raw['phase'] !== 'result')) {
    throw new Error('malformed op_res: opId/phase missing');
  }
  return raw as unknown as OpResMsg;
}

export function decodePresence(payload: Buffer): PresenceMsg {
  const raw = decodeJsonPayload(payload) as Record<string, unknown>;
  const event = raw['event'];
  if (event !== 'join' && event !== 'quit' && event !== 'snapshot') {
    throw new Error('malformed presence: unknown event');
  }
  return {
    event,
    player: (raw['player'] as PresenceMsg['player']) ?? null,
    online: (raw['online'] as PresenceMsg['online']) ?? null,
  };
}

export function encodeQuestDown(teams: QuestTeam[]): Buffer {
  const w = new Writer().varInt(1).varInt(teams.length);
  for (const t of teams) {
    w.utf(t.teamId).varInt(t.dataVersion).utf(t.snbt);
  }
  return w.build();
}

export function encodeChunksDown(teams: ChunkTeam[]): Buffer {
  const w = new Writer().varInt(1).varInt(teams.length);
  for (const t of teams) {
    w.utf(t.teamId).varInt(t.claims.length);
    for (const c of t.claims) {
      w.utf(c.dimension).varInt(c.x).varInt(c.z).bool(c.force);
    }
  }
  return w.build();
}
