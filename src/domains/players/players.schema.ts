import { z } from 'zod';

export const playerParamsSchema = z.object({
  nick: z.string().min(1).max(36),
});

export const playerServerParamsSchema = z.object({
  nick: z.string().min(1).max(36),
  tag: z.string().min(1).max(20),
});

export const historyGranularitySchema = z.enum(['minute5', 'minute15', 'hour', 'hour4', 'hour12', 'day']);

export const historyQuerySchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date().optional(),
  server: z.string().min(1).max(20).optional(),
  granularity: historyGranularitySchema.optional(),
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

export type PlayerParams = z.infer<typeof playerParamsSchema>;
export type PlayerServerParams = z.infer<typeof playerServerParamsSchema>;
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export type HistoryGranularity = z.infer<typeof historyGranularitySchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type LeaderboardQuery = z.infer<typeof leaderboardQuerySchema>;
export type SkinQuery = z.infer<typeof skinQuerySchema>;
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
