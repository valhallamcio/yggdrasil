import { Router } from 'express';
//import { exampleRouter } from '../../../domains/example/example.router.js';
import { donationsRouter } from '../../../domains/donations/donations.router.js';
import { showcaseRouter } from '../../../domains/showcase/showcase.router.js';

// v1 router — the single place that defines URL structure for API v1.
// Adding a new domain: one import + one use() call here.
export const v1Router = Router();

//v1Router.use('/examples', exampleRouter);
v1Router.use('/donations', donationsRouter);
v1Router.use('/showcase', showcaseRouter);
