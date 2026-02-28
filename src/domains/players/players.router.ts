import { Router } from 'express';
import { PlayersRepository } from './players.repository.js';
import { PlayersService } from './players.service.js';
import { PlayersController } from './players.controller.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../shared/utils/async-handler.js';
import { apiKeyAuth, optionalApiKeyAuth } from '../../middleware/auth/api-key.js';
import {
  playerParamsSchema,
  playerServerParamsSchema,
  historyQuerySchema,
  analyticsQuerySchema,
  searchQuerySchema,
  leaderboardQuerySchema,
  skinQuerySchema,
  editPositionBodySchema,
  editInventoryBodySchema,
  editStatsBodySchema,
} from './players.schema.js';

// Composition root
const repo = new PlayersRepository();
const service = new PlayersService(repo);
const controller = new PlayersController(service);

export const playersRouter = Router();
export { service as playersService };

// ── Public routes ──────────────────────────────────────────────────────────

playersRouter.get(
  '/',
  optionalApiKeyAuth(),
  asyncHandler(controller.list),
);

// ── Named routes (must be before /:nick) ───────────────────────────────────

playersRouter.get(
  '/history',
  apiKeyAuth(),
  validate({ query: historyQuerySchema }),
  asyncHandler(controller.history),
);

playersRouter.get(
  '/analytics',
  apiKeyAuth(),
  validate({ query: analyticsQuerySchema }),
  asyncHandler(controller.analytics),
);

playersRouter.get(
  '/search',
  apiKeyAuth(),
  validate({ query: searchQuerySchema }),
  asyncHandler(controller.search),
);

playersRouter.get(
  '/leaderboard',
  optionalApiKeyAuth(),
  validate({ query: leaderboardQuerySchema }),
  asyncHandler(controller.leaderboard),
);

// ── Individual player routes ───────────────────────────────────────────────

playersRouter.get(
  '/:nick',
  optionalApiKeyAuth(),
  validate({ params: playerParamsSchema }),
  asyncHandler(controller.getOne),
);

playersRouter.get(
  '/:nick/skin',
  validate({ params: playerParamsSchema, query: skinQuerySchema }),
  asyncHandler(controller.skin),
);

// ── Per-server player data routes ──────────────────────────────────────────

playersRouter.get(
  '/:nick/:tag/stats',
  apiKeyAuth(),
  validate({ params: playerServerParamsSchema }),
  asyncHandler(controller.getStats),
);

playersRouter.put(
  '/:nick/:tag/stats',
  apiKeyAuth(),
  validate({ params: playerServerParamsSchema, body: editStatsBodySchema }),
  asyncHandler(controller.updateStats),
);

playersRouter.get(
  '/:nick/:tag/inventory',
  apiKeyAuth(),
  validate({ params: playerServerParamsSchema }),
  asyncHandler(controller.getInventory),
);

playersRouter.put(
  '/:nick/:tag/inventory',
  apiKeyAuth(),
  validate({ params: playerServerParamsSchema, body: editInventoryBodySchema }),
  asyncHandler(controller.updateInventory),
);

playersRouter.get(
  '/:nick/:tag/position',
  apiKeyAuth(),
  validate({ params: playerServerParamsSchema }),
  asyncHandler(controller.getPosition),
);

playersRouter.put(
  '/:nick/:tag/position',
  apiKeyAuth(),
  validate({ params: playerServerParamsSchema, body: editPositionBodySchema }),
  asyncHandler(controller.updatePosition),
);

playersRouter.get(
  '/:nick/:tag/advancements',
  apiKeyAuth(),
  validate({ params: playerServerParamsSchema }),
  asyncHandler(controller.getAdvancements),
);
