import pino from 'pino';
import { config } from '../../config/index.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  ...(config.LOG_PRETTY && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard' },
    },
  }),
  base: { env: config.NODE_ENV },
});

export type Logger = typeof logger;
