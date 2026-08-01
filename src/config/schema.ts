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
  PLUGIN_BIFORESTING_LINK: booleanFromString.default('false'),

  BIFORESTING_PSK: z.string().optional(),
  BIFORESTING_AUTHKEY_HEX: z.string().optional(),

  DISCORD_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),

  DISCORD_WEBHOOK_USERNAME: z.string().default('Yggdrasil'),
  DISCORD_WEBHOOK_AVATAR_URL: z.string().url().optional(),

  KOFI_VERIFICATION_TOKEN: z.string().optional(),
  PATREON_WEBHOOK_SECRET: z.string().optional(),
  DISCORD_DONATIONS_CHANNEL_ID: z.string().optional(),
  DISCORD_DONATIONS_LOG_CHANNEL_ID: z.string().optional(),

  DISCORD_SCREENSHOT_CHANNEL_ID: z.string().optional(),

  PTERODACTYL_URL: z.string().url().optional(),
  PTERODACTYL_API_KEY: z.string().optional(),
  DISCORD_SERVER_STATUS_CHANNEL_ID: z.string().optional(),
  DISCORD_SERVER_STATUS_PUBLIC_CHANNEL_ID: z.string().optional(),
  DISCORD_SERVER_STATUS_WEBHOOK_USERNAME: z.string().default('Server Status'),
  DISCORD_SERVER_STATUS_WEBHOOK_AVATAR_URL: z.string().url().optional(),

  // Pterodactyl server ID of the Bifrost/Velocity proxy. Used to broadcast
  // donations in-game via the `bc` command. The proxy is not a row in the
  // `servers` collection, so it is addressed by its Pterodactyl ID directly.
  PROXY_PTERODACTYL_SERVER_ID: z.string().optional(),

  VELOCITY_METRICS_URL: z.string().url().optional().or(z.literal('')),
}).superRefine((data, ctx) => {
  if (data.PLUGIN_BIFORESTING_LINK && !data.BIFORESTING_PSK && !data.BIFORESTING_AUTHKEY_HEX) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['BIFORESTING_PSK'],
      message: 'PLUGIN_BIFORESTING_LINK=true requires BIFORESTING_PSK or BIFORESTING_AUTHKEY_HEX',
    });
  }

  // The /biforesting/ listener is stood up inside WebSocketPlugin, so the link plugin
  // alone gives you REST + the ops dispatcher but nothing for a game server to dial —
  // it boots clean and every mod fails to connect in silence. WS is the only transport
  // (raw TCP was removed), so this combination is never valid; fail the boot instead.
  if (data.PLUGIN_BIFORESTING_LINK && !data.PLUGIN_WEBSOCKET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PLUGIN_WEBSOCKET'],
      message: 'PLUGIN_BIFORESTING_LINK=true requires PLUGIN_WEBSOCKET=true (the /biforesting/ WS listener lives in the websocket plugin)',
    });
  }
});

export type Config = z.output<typeof configSchema>;
