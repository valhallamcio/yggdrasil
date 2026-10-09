import type { Request, RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

/** Mount of the player sync REST routes. */
export const SYNC_API_PREFIX = '/v1/biforesting/sync';

/** True for a path under the sync mount. Express routes ignore case, so this check does too. */
export function isSyncApiPath(path: string): boolean {
  const p = path.toLowerCase();
  return p === SYNC_API_PREFIX || p.startsWith(`${SYNC_API_PREFIX}/`);
}

export interface RateLimitSettings {
  windowMs: number;
  max: number;
  syncWindowMs: number;
  syncMax: number;
  /** Header that carries the API key (config `API_KEY_HEADER`). */
  apiKeyHeader: string;
  /** The valid API keys (config `API_KEYS`). Only these get a bucket of their own. */
  apiKeys: readonly string[];
}

/**
 * The global limiter counts per client IP and skips the sync routes. Bifrost holds logins by
 * polling those routes from one IP, so they get their own limiter, keyed by the API key. Only a
 * key in the valid key list gets its own bucket. A request with an unknown key or with no key
 * counts against its IP, so a caller who guesses keys stays under one per-IP cap.
 */
export function createRateLimiters(s: RateLimitSettings): { global: RequestHandler; sync: RequestHandler } {
  const header = s.apiKeyHeader.toLowerCase();
  const validKeys = new Set(s.apiKeys);
  return {
    global: rateLimit({
      windowMs: s.windowMs,
      max: s.max,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req: Request) => isSyncApiPath(req.path),
    }),
    sync: rateLimit({
      windowMs: s.syncWindowMs,
      max: s.syncMax,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req: Request) => {
        const key = req.headers[header];
        return typeof key === 'string' && validKeys.has(key) ? `key:${key}` : `ip:${req.ip ?? ''}`;
      },
    }),
  };
}
