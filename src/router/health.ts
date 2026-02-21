import { Router } from 'express';
import { asyncHandler } from '../shared/utils/async-handler.js';
import { getDb } from '../core/database/client.js';

export const healthRouter = Router();

healthRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    let dbStatus: 'ok' | 'error' = 'ok';
    try {
      await getDb().command({ ping: 1 });
    } catch {
      dbStatus = 'error';
    }

    const httpStatus = dbStatus === 'ok' ? 200 : 503;
    res.status(httpStatus).json({
      status: dbStatus === 'ok' ? 'healthy' : 'degraded',
      checks: { database: dbStatus },
      timestamp: new Date().toISOString(),
    });
  })
);
