import { Router, type RequestHandler } from 'express';
import type { ZodSchema } from 'zod';
import { AppError } from '../../shared/errors/index.js';
import { SyncController } from './sync.controller.js';
import { validate } from '../../middleware/validate.js';
import { apiKeyAuth } from '../../middleware/auth/api-key.js';
import { asyncHandler } from '../../shared/utils/async-handler.js';
import {
  shadowMoveBodySchema,
  syncForceReleaseBodySchema,
  syncGroupParamsSchema,
  syncGroupPutBodySchema,
  syncMoveListQuerySchema,
  syncMoveParamsSchema,
  syncMoveStartBodySchema,
  syncMoveWaitQuerySchema,
  syncPlayerParamsSchema,
  syncQuestActionBodySchema,
  syncQuestMergeBodySchema,
  syncReseedBodySchema,
  syncSnapshotIdParamsSchema,
  syncSnapshotListQuerySchema,
} from './sync.schema.js';

/**
 * Player sync routes, mounted at `/v1/biforesting/sync` before the `/:server` routes. The app
 * gives this mount its own rate limiter keyed by API key (`middleware/rate-limit.ts`).
 */
const controller = new SyncController();

export const syncRouter = Router();

// Literal /snapshots first, so a group can never shadow it.
syncRouter.get(
  '/snapshots/:id',
  apiKeyAuth(),
  validate({ params: syncSnapshotIdParamsSchema }),
  asyncHandler(controller.getSnapshot),
);

syncRouter.get('/:group', apiKeyAuth(), validate({ params: syncGroupParamsSchema }), asyncHandler(controller.getGroup));

syncRouter.put(
  '/:group',
  apiKeyAuth(),
  validate({ params: syncGroupParamsSchema, body: syncGroupPutBodySchema }),
  asyncHandler(controller.putGroup),
);

// After a restore of one instance (Valhalla-Updater). The group must be frozen.
syncRouter.post(
  '/:group/reseed',
  apiKeyAuth(),
  validate({ params: syncGroupParamsSchema, body: syncReseedBodySchema }),
  asyncHandler(controller.postReseed),
);

syncRouter.get(
  '/:group/players/:uuid',
  apiKeyAuth(),
  validate({ params: syncPlayerParamsSchema }),
  asyncHandler(controller.getPlayer),
);

syncRouter.post(
  '/:group/players/:uuid/shadow-move',
  apiKeyAuth(),
  validate({ params: syncPlayerParamsSchema, body: shadowMoveBodySchema }),
  asyncHandler(controller.postShadowMove),
);

syncRouter.get(
  '/:group/players/:uuid/snapshots',
  apiKeyAuth(),
  validate({ params: syncPlayerParamsSchema, query: syncSnapshotListQuerySchema }),
  asyncHandler(controller.listSnapshots),
);

// ── Moves (S2) ───────────────────────────────────────────────────────────────

syncRouter.post(
  '/:group/players/:uuid/moves',
  apiKeyAuth(),
  validate({ params: syncPlayerParamsSchema, body: syncMoveStartBodySchema }),
  asyncHandler(controller.postMove),
);

syncRouter.get(
  '/:group/players/:uuid/moves',
  apiKeyAuth(),
  validate({ params: syncPlayerParamsSchema, query: syncMoveListQuerySchema }),
  asyncHandler(controller.listMoves),
);

syncRouter.get(
  '/:group/players/:uuid/moves/:moveId',
  apiKeyAuth(),
  validate({ params: syncMoveParamsSchema, query: syncMoveWaitQuerySchema }),
  asyncHandler(controller.getMove),
);

syncRouter.post(
  '/:group/players/:uuid/moves/:moveId/cancel',
  apiKeyAuth(),
  validate({ params: syncMoveParamsSchema }),
  asyncHandler(controller.cancelMove),
);

// ── Quest progress (phase6 DESIGN 4 and 7) ───────────────────────────────────

/** A bad quest body is a 400 with code `bad_value` (the code Bifrost names, contract-notes-bifrost.md). */
function validateQuestBody(schema: ZodSchema): RequestHandler {
  return (req, _res, next): void => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      next(new AppError('Request validation failed', 400, 'bad_value', { body: parsed.error.flatten().fieldErrors }));
      return;
    }
    req.body = parsed.data;
    next();
  };
}

syncRouter.get(
  '/:group/players/:uuid/quests',
  apiKeyAuth(),
  validate({ params: syncPlayerParamsSchema }),
  asyncHandler(controller.getQuests),
);

syncRouter.post(
  '/:group/players/:uuid/quests/action',
  apiKeyAuth(),
  validate({ params: syncPlayerParamsSchema }),
  validateQuestBody(syncQuestActionBodySchema),
  asyncHandler(controller.postQuestAction),
);

syncRouter.get(
  '/:group/players/:uuid/quests/party-candidates',
  apiKeyAuth(),
  validate({ params: syncPlayerParamsSchema }),
  asyncHandler(controller.getQuestCandidates),
);

syncRouter.post(
  '/:group/players/:uuid/quests/party-merge',
  apiKeyAuth(),
  validate({ params: syncPlayerParamsSchema }),
  validateQuestBody(syncQuestMergeBodySchema),
  asyncHandler(controller.postQuestMerge),
);

syncRouter.post(
  '/:group/players/:uuid/force-release',
  apiKeyAuth(),
  validate({ params: syncPlayerParamsSchema, body: syncForceReleaseBodySchema }),
  asyncHandler(controller.forceRelease),
);
