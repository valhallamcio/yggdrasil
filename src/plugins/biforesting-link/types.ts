import type { ObjectId } from 'mongodb';

// ── Decoded UP payloads (mirror bifrost-lib/test/ygg_mock.py parsers) ─────────

export interface DimMetrics {
  dim: string;
  tickMsAvg: number;
  tickMsMax: number;
  entities: Array<{ type: string; n: number }>;
  totalEntities: number;
  loadedChunks: number;
}

export interface LinkMetrics {
  mspt: number;
  tps: number;
  players: number;
  levels: number;
  loadedChunks: number;
  heapUsed: number;
  heapMax: number;
  /** Metrics v2 extras (absent on v1 senders). `mspt` above = v2 `msptAvg`. */
  v?: number;
  msptMax?: number;
  perDim?: DimMetrics[];
  censusAgeMs?: number;
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
  /** Link semantics version the mod speaks (1 = feat-era, 2 = policy-gated). */
  linkProtocolVersion: number;
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
  /** min(mod's linkProtocolVersion, ours). */
  negotiatedVersion: number;
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

// ── Durable ops (biforesting_ops — the keystone job store) ──────────────────

export type OpState =
  | 'pending'
  | 'dispatched'
  | 'acked'
  | 'waiting_player'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelled';

export interface OpTarget {
  uuid?: string;
  name?: string;
}

export interface OpFlags {
  /** How to handle an offline target: queue for login (default), offline-edit in-JVM, or reject. */
  offlineMode?: 'queue' | 'offline-edit' | 'reject';
  dryRun?: boolean;
}

export interface OpAuditEntry {
  at: Date;
  from: OpState | null;
  to: OpState;
  note?: string;
}

export interface OpResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  durationMs?: number;
}

/** One durable op in `biforesting_ops`. `_id` is a ULID (time-sortable). */
export interface OpDoc {
  _id: string;
  /** Client-supplied replay guard — POSTing the same key returns the existing op. */
  idempotencyKey?: string;
  instanceKey: string;
  serverTag: string | null;
  type: string;
  params: Record<string, unknown>;
  target: OpTarget | null;
  flags: OpFlags;
  state: OpState;
  attempts: number;
  maxAttempts: number;
  dispatchTimeoutMs: number;
  execTimeoutMs: number;
  notBefore: Date | null;
  expiresAt: Date;
  parentOpId: string | null;
  childIndex: number | null;
  createdBy: string;
  audit: OpAuditEntry[];
  result: OpResult | null;
  createdAt: Date;
  updatedAt: Date;
  dispatchedAt: Date | null;
  ackedAt: Date | null;
  completedAt: Date | null;
}

/** Decoded `biforesting:op_res` (UP): ack that an op arrived, then its terminal result. */
export interface OpResMsg {
  opId: string;
  phase: 'ack' | 'result';
  /** result phase only. */
  status?: 'completed' | 'failed' | 'waiting_player';
  result?: unknown;
  error?: string;
  durationMs?: number;
  /** True when the mod answered from its dedup journal instead of re-executing. */
  journalReplay?: boolean;
}

/** Decoded `biforesting:presence` (UP): join/quit events + full snapshot on link-up. */
export interface PresenceMsg {
  event: 'join' | 'quit' | 'snapshot';
  player: { uuid: string; name: string } | null;
  online: Array<{ uuid: string; name: string }> | null;
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
