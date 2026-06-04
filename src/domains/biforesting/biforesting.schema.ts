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

export type LinkServerParams = z.infer<typeof linkServerParamsSchema>;
export type QuestDownBody = z.infer<typeof questDownBodySchema>;
export type ChunksDownBody = z.infer<typeof chunksDownBodySchema>;
