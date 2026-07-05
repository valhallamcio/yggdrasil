import { Router } from 'express';
import { BiforestingController } from './biforesting.controller.js';
import { validate } from '../../middleware/validate.js';
import { apiKeyAuth } from '../../middleware/auth/api-key.js';
import {
  linkServerParamsSchema,
  policyPutBodySchema,
  questDownBodySchema,
  chunksDownBodySchema,
  opCreateBodySchema,
  opIdParamsSchema,
  opListQuerySchema,
  metricsHistoryQuerySchema,
  playerInvParamsSchema,
  snapshotIdParamsSchema,
  questSearchQuerySchema,
} from './biforesting.schema.js';
import { asyncHandler } from '../../shared/utils/async-handler.js';

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

// ── Durable ops (literal /ops routes BEFORE /:server) ───────────────────────

biforestingRouter.get('/ops-catalog', apiKeyAuth(), controller.getOpsCatalog);

biforestingRouter.get(
  '/ops/:opId',
  apiKeyAuth(),
  validate({ params: opIdParamsSchema }),
  asyncHandler(controller.getOp),
);

biforestingRouter.post(
  '/ops/:opId/cancel',
  apiKeyAuth(),
  validate({ params: opIdParamsSchema }),
  asyncHandler(controller.cancelOp),
);

biforestingRouter.post(
  '/:server/ops',
  apiKeyAuth(),
  validate({ params: linkServerParamsSchema, body: opCreateBodySchema }),
  asyncHandler(controller.createOp),
);

biforestingRouter.get(
  '/:server/ops',
  apiKeyAuth(),
  validate({ params: linkServerParamsSchema, query: opListQuerySchema }),
  asyncHandler(controller.listOps),
);

// ── Inventory snapshots (phase 4, plan D12) ──────────────────────────────────

biforestingRouter.get(
  '/inventory-snapshots/:id',
  apiKeyAuth(),
  validate({ params: snapshotIdParamsSchema }),
  asyncHandler(controller.getInventorySnapshot),
);

biforestingRouter.get(
  '/:server/players/:player/inventory',
  apiKeyAuth(),
  validate({ params: playerInvParamsSchema }),
  asyncHandler(controller.getPlayerInventory),
);

biforestingRouter.get(
  '/:server/players/:player/inventory-snapshots',
  apiKeyAuth(),
  validate({ params: playerInvParamsSchema }),
  asyncHandler(controller.listPlayerSnapshots),
);

// ── Quest registry (phase 6) ─────────────────────────────────────────────────

biforestingRouter.get(
  '/:server/quests',
  apiKeyAuth(),
  validate({ params: linkServerParamsSchema, query: questSearchQuerySchema }),
  asyncHandler(controller.searchQuests),
);

// ── Metrics v2 (plan D13) ────────────────────────────────────────────────────

biforestingRouter.get(
  '/:server/metrics/latest',
  apiKeyAuth(),
  validate({ params: linkServerParamsSchema }),
  asyncHandler(controller.getMetricsLatest),
);

biforestingRouter.get(
  '/:server/metrics/history',
  apiKeyAuth(),
  validate({ params: linkServerParamsSchema, query: metricsHistoryQuerySchema }),
  asyncHandler(controller.getMetricsHistory),
);

// ── Per-server feature policy (authoritative reg_ack source) ────────────────

biforestingRouter.get(
  '/:server/policy',
  apiKeyAuth(),
  validate({ params: linkServerParamsSchema }),
  asyncHandler(controller.getPolicy),
);

biforestingRouter.put(
  '/:server/policy',
  apiKeyAuth(),
  validate({ params: linkServerParamsSchema, body: policyPutBodySchema }),
  asyncHandler(controller.putPolicy),
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
