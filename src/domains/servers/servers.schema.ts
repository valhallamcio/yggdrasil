import { z } from 'zod';

export const serverParamsSchema = z.object({
  server: z.string().min(1).max(20),
});

export const commandBodySchema = z.object({
  command: z.string().min(1).max(2048),
});

export const powerBodySchema = z.object({
  signal: z.enum(['start', 'stop', 'restart', 'kill']),
});

export const fileListQuerySchema = z.object({
  directory: z.string().default('/'),
});

export const fileReadQuerySchema = z.object({
  file: z.string().min(1),
});

export const fileWriteQuerySchema = z.object({
  file: z.string().min(1),
});

export const fileWriteBodySchema = z.object({
  content: z.string(),
});

export const historyQuerySchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date().optional(),
});

export const logsQuerySchema = z.object({
  lines: z.coerce.number().int().min(1).max(5000).default(100),
});

export type ServerParams = z.infer<typeof serverParamsSchema>;
export type CommandBody = z.infer<typeof commandBodySchema>;
export type PowerBody = z.infer<typeof powerBodySchema>;
export type FileListQuery = z.infer<typeof fileListQuerySchema>;
export type FileReadQuery = z.infer<typeof fileReadQuerySchema>;
export type FileWriteQuery = z.infer<typeof fileWriteQuerySchema>;
export type FileWriteBody = z.infer<typeof fileWriteBodySchema>;
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export type LogsQuery = z.infer<typeof logsQuerySchema>;
