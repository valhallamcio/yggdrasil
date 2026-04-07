import { Router } from 'express';
import { ServersRepository } from './servers.repository.js';
import { ServersService } from './servers.service.js';
import { ServersController } from './servers.controller.js';
import { ServerRegistryRepository } from './server-registry.repository.js';
import { ServerRegistryController } from './server-registry.controller.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../shared/utils/async-handler.js';
import { apiKeyAuth, optionalApiKeyAuth } from '../../middleware/auth/api-key.js';
import {
  serverParamsSchema,
  commandBodySchema,
  powerBodySchema,
  fileListQuerySchema,
  fileReadQuerySchema,
  fileWriteQuerySchema,
  fileWriteBodySchema,
  historyQuerySchema,
  logsQuerySchema,
  updateServerBodySchema,
} from './servers.schema.js';

// Composition root
const repo = new ServersRepository();
const service = new ServersService(repo);
const controller = new ServersController(service);

const registryRepo = new ServerRegistryRepository();
const registryController = new ServerRegistryController(registryRepo);

export const serversRouter = Router();
export { service as serversService };

// ── Public routes ──────────────────────────────────────────────────────────

serversRouter.get(
  '/',
  optionalApiKeyAuth(),
  asyncHandler(controller.list),
);

// ── Registry routes (must be before /:server catch-all) ──────────────────

serversRouter.get(
  '/registry',
  apiKeyAuth(),
  asyncHandler(registryController.list),
);

serversRouter.get(
  '/registry/:server',
  apiKeyAuth(),
  validate({ params: serverParamsSchema }),
  asyncHandler(registryController.getOne),
);

// ─────────────────────────────────────────────────────────────────────────

serversRouter.get(
  '/:server',
  optionalApiKeyAuth(),
  validate({ params: serverParamsSchema }),
  asyncHandler(controller.getOne),
);

// ── Protected routes (API key) ─────────────────────────────────────────────

serversRouter.patch(
  '/:server',
  apiKeyAuth(),
  validate({ params: serverParamsSchema, body: updateServerBodySchema }),
  asyncHandler(controller.update),
);

serversRouter.get(
  '/:server/history',
  apiKeyAuth(),
  validate({ params: serverParamsSchema, query: historyQuerySchema }),
  asyncHandler(controller.getHistory),
);

serversRouter.post(
  '/:server/command',
  apiKeyAuth(),
  validate({ params: serverParamsSchema, body: commandBodySchema }),
  asyncHandler(controller.sendCommand),
);

serversRouter.post(
  '/:server/power',
  apiKeyAuth(),
  validate({ params: serverParamsSchema, body: powerBodySchema }),
  asyncHandler(controller.sendPower),
);

serversRouter.get(
  '/:server/files',
  apiKeyAuth(),
  validate({ params: serverParamsSchema, query: fileListQuerySchema }),
  asyncHandler(controller.listFiles),
);

serversRouter.get(
  '/:server/files/contents',
  apiKeyAuth(),
  validate({ params: serverParamsSchema, query: fileReadQuerySchema }),
  asyncHandler(controller.readFile),
);

serversRouter.post(
  '/:server/files/contents',
  apiKeyAuth(),
  validate({ params: serverParamsSchema, query: fileWriteQuerySchema, body: fileWriteBodySchema }),
  asyncHandler(controller.writeFile),
);

serversRouter.get(
  '/:server/logs',
  apiKeyAuth(),
  validate({ params: serverParamsSchema, query: logsQuerySchema }),
  asyncHandler(controller.getConsoleLogs),
);
