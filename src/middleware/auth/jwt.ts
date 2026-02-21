import type { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../../config/index.js';
import { UnauthorizedError } from '../../shared/errors/index.js';

interface JwtPayload {
  sub: string;
  [key: string]: unknown;
}

/**
 * JWT authentication middleware.
 * Expects: Authorization: Bearer <token>
 * On success, sets req.userId from the token's `sub` claim.
 */
export function jwtAuth(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      next(new UnauthorizedError('Missing or invalid Authorization header'));
      return;
    }

    const token = authHeader.slice(7);
    try {
      const payload = jwt.verify(token, config.JWT_SECRET) as JwtPayload;
      req.userId = payload.sub;
      next();
    } catch {
      next(new UnauthorizedError('Invalid or expired token'));
    }
  };
}
