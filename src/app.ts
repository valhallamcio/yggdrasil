import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { config } from './config/index.js';
import { logger } from './core/logger/index.js';
import { createRootRouter } from './router/index.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFoundHandler } from './middleware/not-found.js';
import { requestId } from './middleware/request-id.js';
import { createRateLimiters, SYNC_API_PREFIX } from './middleware/rate-limit.js';

export function createApp(): Express {
  const app = express();

  // ── Proxy trust (behind reverse proxy e.g. Nginx, Pterodactyl) ────────────
  app.set('trust proxy', 1);

  // ── Security ──────────────────────────────────────────────────────────────
  app.use(helmet());
  app.use(
    cors({
      origin: config.NODE_ENV === 'development' ? '*' : [],
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    })
  );

  // ── Request identity ──────────────────────────────────────────────────────
  app.use(requestId);

  // ── Structured request logging ─────────────────────────────────────────────
  app.use(
    pinoHttp({
      logger,
      serializers: {
        req(req: { id: string; method: string; url: string }) {
          return { id: req.id, method: req.method, url: req.url };
        },
        res(res: { statusCode: number }) {
          return { statusCode: res.statusCode };
        },
      },
    })
  );

  // ── Body parsing ──────────────────────────────────────────────────────────
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ extended: true }));

  // ── Rate limiting ─────────────────────────────────────────────────────────
  // Per IP for every route except the player sync routes, which count per API key.
  const limiters = createRateLimiters({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_MAX,
    syncWindowMs: config.SYNC_RATE_LIMIT_WINDOW_MS,
    syncMax: config.SYNC_RATE_LIMIT_MAX,
    apiKeyHeader: config.API_KEY_HEADER,
    apiKeys: config.API_KEYS,
  });
  app.use(limiters.global);
  app.use(SYNC_API_PREFIX, limiters.sync);

  // ── Static files ──────────────────────────────────────────────────────────
  app.use(express.static('public'));

  // ── Routes ────────────────────────────────────────────────────────────────
  app.use('/', createRootRouter());

  // ── 404 (after all routes, before error handler) ──────────────────────────
  app.use(notFoundHandler);

  // ── Global error handler (must be last) ───────────────────────────────────
  app.use(errorHandler);

  return app;
}
