import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { AppError } from '../shared/errors/index.js';
import { logger } from '../core/logger/index.js';

// Must be registered LAST via app.use() — Express identifies 4-arity functions as error handlers
export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void => {
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error({ err, reqId: req.id }, 'Application error');
    } else {
      logger.warn({ err, reqId: req.id }, 'Client error');
    }
    res.status(err.statusCode).json(err.toJSON());
    return;
  }

  // Unrecognized errors — never leak internals to the client
  logger.error({ err, reqId: req.id }, 'Unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
};
