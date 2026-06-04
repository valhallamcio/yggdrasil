import { Router } from 'express';
import { BiforestingController } from './biforesting.controller.js';
import { validate } from '../../middleware/validate.js';
import { apiKeyAuth } from '../../middleware/auth/api-key.js';
import { linkServerParamsSchema, questDownBodySchema, chunksDownBodySchema } from './biforesting.schema.js';

// Handlers are synchronous (no I/O) — Express 4 forwards synchronous throws to the error
// handler, so they're bound directly without asyncHandler.
const controller = new BiforestingController();

export const biforestingRouter = Router();

// ── Link observability (literal /link routes before /:server) ────────────────

biforestingRouter.get('/link', apiKeyAuth(), controller.getLink);

biforestingRouter.get(
  '/link/:server',
  apiKeyAuth(),
  validate({ params: linkServerParamsSchema }),
  controller.getLinkOne,
);

// ── Authoritative DOWN pushes ────────────────────────────────────────────────

biforestingRouter.post(
  '/:server/quest',
  apiKeyAuth(),
  validate({ params: linkServerParamsSchema, body: questDownBodySchema }),
  controller.pushQuest,
);

biforestingRouter.post(
  '/:server/chunks',
  apiKeyAuth(),
  validate({ params: linkServerParamsSchema, body: chunksDownBodySchema }),
  controller.pushChunks,
);
