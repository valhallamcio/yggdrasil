import { Router } from 'express';
import { healthRouter } from './health.js';
import { v1Router } from './api/v1/index.js';
import { v2Router } from './api/v2/index.js';

export function createRootRouter(): Router {
  const router = Router();

  router.use('/health', healthRouter);
  router.use('/v1', v1Router);
  router.use('/v2', v2Router);

  return router;
}
