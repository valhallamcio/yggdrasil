import { Router } from 'express';
import { ServersRepository } from './servers.repository.js';
import { ServersService } from './servers.service.js';
import { ServersController } from './servers.controller.js';
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
} from './servers.schema.js';

// Composition root
const repo = new ServersRepository();
const service = new ServersService(repo);
const controller = new ServersController(service);

export const serversRouter = Router();
export { service as serversService };

// ── Public routes ──────────────────────────────────────────────────────────

serversRouter.get(
  '/',
  optionalApiKeyAuth(),
  asyncHandler(controller.list),
);

serversRouter.get(
  '/:server',
  optionalApiKeyAuth(),
  validate({ params: serverParamsSchema }),
  asyncHandler(controller.getOne),
);

// ── Protected routes (API key) ─────────────────────────────────────────────

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
