import type { Binary } from 'mongodb';

// ── MongoDB Document (valhallamc/players) ───────────────────────────────────

export interface PlayerDocument {
  username: string;
  nickname?: string;
  discord_id?: string;
  uuid: Binary;
  first_seen: Record<string, Date>;
  leave_dates?: Record<string, Date>;
  server: string;
  playtime: Record<string, number>;
}

// ── Metrics (in-memory from Prometheus) ─────────────────────────────────────

export interface PlayerMetrics {
  latencyP95: number;
  latencyAvg: number;
  latencyMin: number;
  latencyMax: number;
}

// ── API DTOs ────────────────────────────────────────────────────────────────

export interface OnlinePlayerDto {
  username: string;
  server: string;
  latencyP95: number;
  latencyAvg: number;
  latencyMin: number;
  latencyMax: number;
}

export interface PlayerDto {
  username: string;
  uuid: string;
  nickname: string | null;
  discordId: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  lastServer: string;
  playtime: Record<string, number>;
  online: boolean;
  currentServer: string | null;
  latency: PlayerMetrics | null;
}

export interface PlayerPositionDto {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  dimension: string;
  gameMode: number;
}

export interface LeaderboardEntryDto {
  username: string;
  uuid: string;
  value: number;
}

// ── Sessions ────────────────────────────────────────────────────────────────

export interface PlayerSessionDocument {
  username: string;
  server: string;
  joinedAt: Date;
  leftAt: Date | null;
  duration: number | null;
  closedReason: 'left' | 'server_change' | 'orphan_cleanup' | null;
}

// ── History (Time Series) ───────────────────────────────────────────────────

export interface PlayerHistoryDocument {
  timestamp: Date;
  source: string;
  playerCount: number;
  peakPlayerCount: number;
  avgLatencyP95: number;
  avgLatencyAvg: number;
}

// ── Peak Tracking ───────────────────────────────────────────────────────────

export interface PeakRecord {
  count: number;
  timestamp: Date;
}

// ── Analytics ───────────────────────────────────────────────────────────────

export interface PlayerAnalyticsDto {
  current: {
    online: number;
    servers: Record<string, number>;
  };
  peaks: {
    allTime: PeakRecord | null;
    lastPeak: PeakRecord | null;
  };
  population: {
    totalUniquePlayers: number;
    totalPlaytimeMs: number;
    avgPlaytimeMs: number;
  };
  newPlayers: {
    today: number;
    last7Days: number;
    last30Days: number;
  };
  uniqueActive: {
    today: number;
    last7Days: number;
    last30Days: number;
  };
  sessions: {
    totalCount: number;
    avgDurationMs: number;
  };
  classification: {
    regulars: number;
    newRegulars: number;
    inactive: number;
    returning: number;
  };
  growth: Array<{ week: string; newPlayers: number }>;
  retention: Array<{
    cohort: string;
    cohortSize: number;
    weeks: Array<{ week: number; returned: number; rate: number }>;
  }>;
}
