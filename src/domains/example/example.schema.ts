import { z } from 'zod';

export const createExampleSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
});

export const updateExampleSchema = createExampleSchema.partial();

export const exampleParamsSchema = z.object({
  id: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid MongoDB ObjectId'),
});

export const exampleQuerySchema = z.object({
  limit: z.string().regex(/^\d+$/).transform(Number).default('20'),
  skip: z.string().regex(/^\d+$/).transform(Number).default('0'),
});

export type CreateExampleDto = z.infer<typeof createExampleSchema>;
export type UpdateExampleDto = z.infer<typeof updateExampleSchema>;
