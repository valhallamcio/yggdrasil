import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { config } from '../../config/index.js';
import { UnauthorizedError } from '../../shared/errors/index.js';

/**
 * API key authentication middleware.
 * Reads the key from the header defined by config.API_KEY_HEADER (default: X-API-Key).
 * Valid keys are defined in config.API_KEYS.
 */
export function apiKeyAuth(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const key = req.headers[config.API_KEY_HEADER.toLowerCase()] as string | undefined;

    if (!key || !config.API_KEYS.includes(key)) {
      next(new UnauthorizedError('Invalid or missing API key'));
      return;
    }

    next();
  };
}

/**
 * Optional API key authentication middleware.
 * Sets req.authenticated = true when a valid key is present, false otherwise.
 * Never rejects the request.
 */
export function optionalApiKeyAuth(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const key = req.headers[config.API_KEY_HEADER.toLowerCase()] as string | undefined;
    req.authenticated = !!key && config.API_KEYS.includes(key);
    next();
  };
}
