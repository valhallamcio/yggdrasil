import type { ObjectId } from 'mongodb';

// ── Decoded UP payloads (mirror bifrost-lib/test/ygg_mock.py parsers) ─────────

export interface LinkMetrics {
  mspt: number;
  tps: number;
  players: number;
  levels: number;
  loadedChunks: number;
  heapUsed: number;
  heapMax: number;
}

export interface RegistryEntry {
  id: string;
  numericId: number;
}

export interface RegistryPayload {
  count: number;
  entries: RegistryEntry[];
}

export interface QuestTeam {
  teamId: string;
  dataVersion: number;
  snbt: string;
}

export interface ChunkClaim {
  dimension: string;
  x: number;
  z: number;
  force: boolean;
}

export interface ChunkTeam {
  teamId: string;
  claims: ChunkClaim[];
}

// ── Register handshake (biforesting:register UP / biforesting:reg_ack DOWN) ────

/** Decoded `biforesting:register` payload (mod → Ygg, right after `hello`). */
export interface RegisterInfo {
  /** Raw `serverId` the mod was configured with (same value as the hello frame). */
  serverId: string;
  /** Operator-supplied display hint; Ygg's resolved name wins when available. */
  friendlyHint: string;
  /** Capability bitfield advertised by the mod. */
  capabilities: number;
  /** Pterodactyl node / host identifier the backend runs on. */
  node: string;
  /** Player-facing game address (host:port). */
  gameAddr: string;
  /**
   * Per-boot nonce. May exceed JS safe-int range, so it is kept as a string
   * (decoded via `Reader.long()` → BigInt → `.toString()`); never coerced to Number.
   */
  bootNonce: string;
}

/** `biforesting:reg_ack` payload (Ygg → mod, DOWN the same link). */
export interface RegAck {
  accepted: boolean;
  canonicalServerId: string;
  friendlyName: string;
  enabledFeatures: number;
  metricsHz: number;
  questHz: number;
  chunkHz: number;
  serverTimeMillis: number;
}

// ── Resolved identity of a connected backend ─────────────────────────────────

export interface LinkIdentity {
  /** Raw `serverId` from the hello frame (what the mod was configured with). */
  linkServerId: string;
  /** Resolved modpack tag, or null if unresolved. */
  tag: string | null;
  /** Stats key: `tag` (single instance) or `tag:serverId` (grouped), or the raw id if unresolved. */
  instanceKey: string;
  /** Display name, or null if unresolved. */
  name: string | null;
  /** Pterodactyl serverId of the matched instance, or null. */
  serverId: string | null;
  /** Mongo _id of the matched server doc, or null. */
  serverOid: ObjectId | null;
  /** True when the id matched a known server (by serverId or tag). */
  resolved: boolean;
}

// ── Session snapshot (observability) ─────────────────────────────────────────

export interface LinkSessionSnapshot {
  sessionId: string;
  remote: string;
  identity: LinkIdentity | null;
  connectedAt: string;
  lastFrameAt: string | null;
  bytesIn: number;
  framesAccepted: number;
  framesRejected: number;
  metrics: LinkMetrics | null;
  registryCount: number;
  questTeams: number;
  chunkTeams: number;
  lastDataVersion: number | null;
  /** Metadata from the `biforesting:register` handshake, if the mod sent one. */
  register: RegisterInfo | null;
}

export interface LinkSnapshot {
  listening: boolean;
  sessions: LinkSessionSnapshot[];
  count: number;
  timestamp: string;
}
