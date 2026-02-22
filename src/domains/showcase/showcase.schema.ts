import { z } from 'zod';

export const showcaseQuerySchema = z.object({
  count: z.coerce.number().int().min(1).max(50).default(6),
});

export type ShowcaseQuery = z.infer<typeof showcaseQuerySchema>;
