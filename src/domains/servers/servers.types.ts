import type { ObjectId } from 'mongodb';

// ── MongoDB Documents ────────────────────────────────────────────────────────

export interface ServerDocument {
  _id: ObjectId;
  hostname: string;
  port: number;
  tag: string;
  desc: string;
  discord_role_id: string;
  name: string;
  server_version: string;
  modpack_version: string;
  genre: string;
  early_access: boolean;
  excludeFromServerList: boolean;
  color: string;
  serverId: string;
  image: string;
  modpackID: number;
  fileID: number;
  newestFileID?: number;
  requiresUpdate?: boolean;
  platform: string;
  default: boolean;
  gtnhSlots: boolean;
  hasVia: boolean;
  isFabric: boolean;
  isForge: boolean;
  mods: unknown[];
  tags: string[];
}

export interface ShardDocument {
  _id: ObjectId;
  server: ObjectId;
  name: string;
  hostname: string;
  port: number;
  tps: number;
  players: number;
  whitelisted: boolean;
  is_stopping: boolean;
  started: Date;
  updated: Date;
}

// ── Pterodactyl API Shapes ───────────────────────────────────────────────────

export interface PterodactylStats {
  memory_bytes: number;
  memory_limit_bytes: number;
  cpu_absolute: number;
  network: { rx_bytes: number; tx_bytes: number };
  uptime: number;
  state: string;
  disk_bytes: number;
}

export interface PterodactylFileAttributes {
  name: string;
  mode: string;
  mode_bits: string;
  size: number;
  is_file: boolean;
  is_symlink: boolean;
  mimetype: string;
  created_at: string;
  modified_at: string;
}

export interface PterodactylFileEntry {
  object: string;
  attributes: PterodactylFileAttributes;
}

export interface PterodactylWsCredentials {
  token: string;
  socket: string;
}

// ── API DTOs ─────────────────────────────────────────────────────────────────

export interface ServerDto {
  id: string;
  tag: string;
  name: string;
  desc: string;
  hostname: string;
  port: number;
  color: string;
  serverVersion: string;
  modpackVersion: string;
  platform: string;
  earlyAccess: boolean;
  excludeFromServerList: boolean;
  discordRoleId: string;
  serverId: string;
  fileID: number;
  newestFileID?: number;
  requiresUpdate?: boolean;
  modpackID: number;
}

export interface ServerWithStatsDto extends ServerDto {
  status: string;
  cpu: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  diskBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
  uptimeMs: number;
  tps: number;
  players: number;
  whitelisted: boolean;
}

export interface ServerPublicDto {
  tag: string;
  name: string;
  desc: string;
  color: string;
  image: string;
  genre: string;
  platform: string;
  serverVersion: string;
  modpackVersion: string;
  status: string;
  players: number;
  tps: number;
}

export interface FileEntryDto {
  name: string;
  size: number;
  isFile: boolean;
  isSymlink: boolean;
  mimetype: string;
  createdAt: string;
  modifiedAt: string;
}

// ── Server Registry (local mirror) ───────────────────────────────────────────

export interface ServerRegistryDocument {
  tag: string;
  name: string;
  desc: string;
  color: string;
  image: string;
  genre: string;
  platform: string;
  serverVersion: string;
  modpackVersion: string;
  earlyAccess: boolean;
  active: boolean;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ServerRegistryDto {
  tag: string;
  name: string;
  desc: string;
  color: string;
  image: string;
  genre: string;
  platform: string;
  serverVersion: string;
  modpackVersion: string;
  earlyAccess: boolean;
  active: boolean;
  lastSeenAt: string;
}

// ── Stats History (Time Series) ──────────────────────────────────────────────

export interface StatsHistoryDocument {
  timestamp: Date;
  server: string;
  status: string;
  cpu: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  diskBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
  uptime: number;
  tps: number;
  players: number;
  /** ms in `running` state accumulated during the write interval (since last recorded row). */
  uptimeDelta: number;
  /** count of transitions into a non-running state observed during the write interval. */
  downtimeEvents: number;
}
