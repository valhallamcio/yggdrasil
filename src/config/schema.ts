import { z } from 'zod';

const booleanFromString = z
  .string()
  .toLowerCase()
  .transform((v) => v === 'true')
  .pipe(z.boolean());

const numberFromString = (defaultValue: string) =>
  z.string().regex(/^\d+$/).transform(Number).default(defaultValue);

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: numberFromString('3000'),
  HOST: z.string().default('0.0.0.0'),

  MONGODB_URI: z.string().url(),
  MONGODB_DB_NAME: z.string().min(1),

  JWT_SECRET: z.string().min(32),
  API_KEY_HEADER: z.string().default('X-API-Key'),
  API_KEYS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((k) => k.trim()).filter(Boolean)),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: booleanFromString.default('false'),

  RATE_LIMIT_WINDOW_MS: numberFromString('900000'),
  RATE_LIMIT_MAX: numberFromString('100'),

  PLUGIN_DISCORD: booleanFromString.default('false'),
  PLUGIN_WEBSOCKET: booleanFromString.default('false'),

  DISCORD_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),

  KOFI_VERIFICATION_TOKEN: z.string().optional(),
  PATREON_WEBHOOK_SECRET: z.string().optional(),
  DISCORD_DONATIONS_CHANNEL_ID: z.string().optional(),
  DISCORD_DONATIONS_LOG_CHANNEL_ID: z.string().optional(),

  DISCORD_SCREENSHOT_CHANNEL_ID: z.string().optional(),

  PTERODACTYL_URL: z.string().url().optional(),
  PTERODACTYL_API_KEY: z.string().optional(),
  DISCORD_SERVER_STATUS_CHANNEL_ID: z.string().optional(),

  VELOCITY_METRICS_URL: z.string().url().optional(),
});

export type Config = z.output<typeof configSchema>;
