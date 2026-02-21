import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { ZodSchema } from 'zod';
import { ValidationError } from '../shared/errors/index.js';

interface ValidateTargets {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

/**
 * Middleware factory for Zod-based request validation.
 *
 * Usage: router.post('/users', validate({ body: createUserSchema }), controller.create)
 *
 * On success, replaces req.body/query/params with the parsed (coerced) value.
 * On failure, calls next() with a ValidationError (400).
 */
export function validate(targets: ValidateTargets): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const errors: Record<string, unknown> = {};
    const reqAsMap = req as unknown as Record<string, unknown>;

    for (const [target, schema] of Object.entries(targets) as [keyof ValidateTargets, ZodSchema][]) {
      const result = schema.safeParse(reqAsMap[target]);
      if (!result.success) {
        errors[target] = result.error.flatten().fieldErrors;
      } else {
        reqAsMap[target] = result.data;
      }
    }

    if (Object.keys(errors).length > 0) {
      next(new ValidationError('Request validation failed', errors));
      return;
    }

    next();
  };
}
