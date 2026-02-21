import type { Request, Response, NextFunction, RequestHandler } from 'express';

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

/**
 * Wraps an async Express handler so rejected promises are forwarded to next().
 * Required for Express 4 — Express 5 handles this natively.
 *
 * Usage: router.get('/', asyncHandler(async (req, res) => { ... }))
 */
export function asyncHandler(fn: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
