import { z } from 'zod';

/** A server identifier in the URL: link serverId, Pterodactyl serverId, tag, or instanceKey (`tag:id`). */
export const linkServerParamsSchema = z.object({
  server: z.string().min(1).max(64),
});

// ── Metrics history (v2, plan D13) ───────────────────────────────────────────

export const metricsHistoryQuerySchema = z.object({
  res: z.enum(['raw', 'hourly']).default('raw'),
  sinceHours: z.coerce.number().int().min(1).max(720).optional(),
});

// ── Durable ops ──────────────────────────────────────────────────────────────

export const opIdParamsSchema = z.object({
  opId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'opId must be a ULID'),
});

/** POST body for op creation. `params` is validated per-type against the ops catalog. */
export const opCreateBodySchema = z.object({
  type: z.string().min(1).max(64),
  params: z.record(z.unknown()).default({}),
  target: z
    .object({
      uuid: z.string().uuid().optional(),
      name: z.string().min(1).max(32).optional(),
    })
    .refine((t) => t.uuid !== undefined || t.name !== undefined, { message: 'target needs uuid or name' })
    .optional(),
  flags: z
    .object({
      offlineMode: z.enum(['queue', 'offline-edit', 'reject']).optional(),
      dryRun: z.boolean().optional(),
    })
    .optional(),
  idempotencyKey: z.string().min(8).max(128).optional(),
  notBefore: z.coerce.date().optional(),
  expiresInMs: z.number().int().min(60_000).max(30 * 24 * 3600_000).optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
  dispatchTimeoutMs: z.number().int().min(1_000).max(300_000).optional(),
  execTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
});

export const opListQuerySchema = z.object({
  state: z
    .enum(['pending', 'dispatched', 'acked', 'waiting_player', 'completed', 'failed', 'expired', 'cancelled'])
    .optional(),
  type: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const questDownBodySchema = z.object({
  teams: z
    .array(
      z.object({
        teamId: z.string().min(1),
        dataVersion: z.number().int().nonnegative(),
        snbt: z.string(),
      }),
    )
    .min(1),
});

export const chunksDownBodySchema = z.object({
  teams: z
    .array(
      z.object({
        teamId: z.string().min(1),
        claims: z.array(
          z.object({
            dimension: z.string().min(1),
            x: z.number().int(),
            z: z.number().int(),
            force: z.boolean(),
          }),
        ),
      }),
    )
    .min(1),
});

/**
 * Policy PUT body: grant features by NAME (see policy-store FEATURE_BITS) or as a raw bitmask;
 * exactly one of the two. Cadences are optional Hz fields consumed by the mod's features.
 */
export const policyPutBodySchema = z
  .object({
    features: z.array(z.string().min(1)).optional(),
    enabledFeatures: z.number().int().nonnegative().optional(),
    metricsHz: z.number().int().min(0).max(20).optional(),
    questHz: z.number().int().min(0).max(20).optional(),
    chunkHz: z.number().int().min(0).max(20).optional(),
  })
  .refine((b) => (b.features !== undefined) !== (b.enabledFeatures !== undefined) || (b.features === undefined && b.enabledFeatures === undefined), {
    message: 'provide features[] OR enabledFeatures, not both',
  });

export type LinkServerParams = z.infer<typeof linkServerParamsSchema>;
export type PolicyPutBody = z.infer<typeof policyPutBodySchema>;
export type QuestDownBody = z.infer<typeof questDownBodySchema>;
export type ChunksDownBody = z.infer<typeof chunksDownBodySchema>;
export type OpIdParams = z.infer<typeof opIdParamsSchema>;
export type OpCreateBody = z.infer<typeof opCreateBodySchema>;
export type OpListQuery = z.infer<typeof opListQuerySchema>;
export type MetricsHistoryQuery = z.infer<typeof metricsHistoryQuerySchema>;
