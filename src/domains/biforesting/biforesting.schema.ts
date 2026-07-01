import { z } from 'zod';

/** A server identifier in the URL: link serverId, Pterodactyl serverId, tag, or instanceKey (`tag:id`). */
export const linkServerParamsSchema = z.object({
  server: z.string().min(1).max(64),
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
