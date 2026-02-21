import { Router } from 'express';
import { DonationsService } from './donations.service.js';
import { DonationsController } from './donations.controller.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../shared/utils/async-handler.js';
import { kofiBodySchema } from './donations.schema.js';

// Composition root for the donations domain
const service = new DonationsService();
const controller = new DonationsController(service);

export const donationsRouter = Router();

donationsRouter.post('/kofi', validate({ body: kofiBodySchema }), asyncHandler(controller.handleKofi));
donationsRouter.post('/patreon', asyncHandler(controller.handlePatreon));
