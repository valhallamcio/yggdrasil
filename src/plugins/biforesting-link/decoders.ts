import { Reader, Writer } from './frame-codec.js';
import type { LinkMetrics, RegistryPayload, QuestTeam, ChunkTeam, RegisterInfo, RegAck } from './types.js';

/**
 * Payload decoders/encoders for the four link channels. Field order mirrors
 * `bifrost-lib/test/ygg_mock.py` and `Bifrost/docs/biforesting-protocol.md` §5.
 * All payloads start with `[protocolVersion : varint] = 1`.
 */

// ── UP decoders ──────────────────────────────────────────────────────────────

export function decodeMetrics(payload: Buffer): LinkMetrics {
  const r = new Reader(payload);
  r.varInt(); // version
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
  r.varInt(); // version
  const serverId = r.utf();
  const friendlyHint = r.utf();
  const capabilities = r.varInt();
  const node = r.utf();
  const gameAddr = r.utf();
  const bootNonce = r.long().toString();
  return { serverId, friendlyHint, capabilities, node, gameAddr, bootNonce };
}

// ── DOWN encoders (authoritative pushes) ─────────────────────────────────────

/**
 * Encode `biforesting:reg_ack`:
 *   [varint ver=1][byte accepted(1/0)][utf canonicalServerId][utf friendlyName]
 *   [varint enabledFeatures][varint metricsHz][varint questHz][varint chunkHz][int64 serverTimeMillis]
 *
 * `accepted` is a plain 0/1 wire byte (NOT a varint). `serverTimeMillis` is written
 * as a big-endian int64.
 */
export function encodeRegAck(ack: RegAck): Buffer {
  return new Writer()
    .varInt(1)
    .byte(ack.accepted ? 1 : 0)
    .utf(ack.canonicalServerId)
    .utf(ack.friendlyName)
    .varInt(ack.enabledFeatures)
    .varInt(ack.metricsHz)
    .varInt(ack.questHz)
    .varInt(ack.chunkHz)
    .long(BigInt(ack.serverTimeMillis))
    .build();
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
