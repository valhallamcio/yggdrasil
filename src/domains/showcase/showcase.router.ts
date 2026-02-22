import { Router } from 'express';
import { ShowcaseRepository } from './showcase.repository.js';
import { ShowcaseService } from './showcase.service.js';
import { ShowcaseController } from './showcase.controller.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../shared/utils/async-handler.js';
import { apiKeyAuth } from '../../middleware/auth/api-key.js';
import { showcaseQuerySchema } from './showcase.schema.js';

// Composition root for the showcase domain
const repo = new ShowcaseRepository();
const service = new ShowcaseService(repo);
const controller = new ShowcaseController(service);

export const showcaseRouter = Router();

showcaseRouter.get('/', validate({ query: showcaseQuerySchema }), asyncHandler(controller.list));
showcaseRouter.post('/refresh', apiKeyAuth(), asyncHandler(controller.refresh));

export { service as showcaseService };
