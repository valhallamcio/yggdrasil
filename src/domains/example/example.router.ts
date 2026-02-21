import { Router } from 'express';
import { ExampleRepository } from './example.repository.js';
import { ExampleService } from './example.service.js';
import { ExampleController } from './example.controller.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../shared/utils/async-handler.js';
import {
  createExampleSchema,
  updateExampleSchema,
  exampleParamsSchema,
  exampleQuerySchema,
} from './example.schema.js';

// Composition root for the example domain — wires the dependency chain
const repo = new ExampleRepository();
const service = new ExampleService(repo);
const controller = new ExampleController(service);

export const exampleRouter = Router();

exampleRouter
  .route('/')
  .get(validate({ query: exampleQuerySchema }), asyncHandler(controller.getAll))
  .post(validate({ body: createExampleSchema }), asyncHandler(controller.create));

exampleRouter
  .route('/:id')
  .get(validate({ params: exampleParamsSchema }), asyncHandler(controller.getById))
  .patch(
    validate({ params: exampleParamsSchema, body: updateExampleSchema }),
    asyncHandler(controller.update)
  )
  .delete(validate({ params: exampleParamsSchema }), asyncHandler(controller.delete));
