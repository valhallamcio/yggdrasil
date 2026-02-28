import { z } from 'zod';

export const playerParamsSchema = z.object({
  nick: z.string().min(1).max(32),
});

export const playerServerParamsSchema = z.object({
  nick: z.string().min(1).max(32),
  tag: z.string().min(1).max(20),
});

export const historyQuerySchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date().optional(),
  server: z.string().min(1).max(20).optional(),
});

export const analyticsQuerySchema = z.object({
  server: z.string().min(1).max(20).optional(),
});

export const searchQuerySchema = z.object({
  q: z.string().min(2).max(32),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const leaderboardQuerySchema = z.object({
  sort: z.enum(['playtime', 'first_seen']),
  tag: z.string().min(1).max(20).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const skinQuerySchema = z.object({
  size: z.coerce.number().int().min(8).max(512).default(128),
});

export const editPositionBodySchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  yaw: z.number().optional(),
  pitch: z.number().optional(),
  dimension: z.string().optional(),
  gameMode: z.number().int().min(0).max(3).optional(),
});

export const editInventoryBodySchema = z.object({
  inventory: z.array(z.record(z.unknown())),
});

export const editStatsBodySchema = z.object({
  stats: z.record(z.record(z.number())),
});

export type PlayerParams = z.infer<typeof playerParamsSchema>;
export type PlayerServerParams = z.infer<typeof playerServerParamsSchema>;
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type LeaderboardQuery = z.infer<typeof leaderboardQuerySchema>;
export type SkinQuery = z.infer<typeof skinQuerySchema>;
export type EditPositionBody = z.infer<typeof editPositionBodySchema>;
export type EditInventoryBody = z.infer<typeof editInventoryBodySchema>;
export type EditStatsBody = z.infer<typeof editStatsBodySchema>;
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
