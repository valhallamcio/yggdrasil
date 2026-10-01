import { Router, json } from 'express';
import { BiforestingController } from './biforesting.controller.js';
import { ProfilesController, profileTraceAuth } from './profiles.controller.js';
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
  itemSearchQuerySchema,
  packParamsSchema,
  packIconParamsSchema,
  packLangBodySchema,
  iconsUploadBodySchema,
  profileCaptureBodySchema,
  profileParamsSchema,
  profileArtifactParamsSchema,
  profileListQuerySchema,
  fleetHotspotsQuerySchema,
  profileViewQuerySchema,
} from './biforesting.schema.js';
import { asyncHandler } from '../../shared/utils/async-handler.js';

// Handlers are synchronous (no I/O) — Express 4 forwards synchronous throws to the error
// handler, so they're bound directly without asyncHandler.
const controller = new BiforestingController();
const profiles = new ProfilesController();

export const biforestingRouter = Router();

// ── Link observability (literal /link routes before /:server) ────────────────

biforestingRouter.get('/link', apiKeyAuth(), controller.getLink);

biforestingRouter.get(
  '/link/:server',
  apiKeyAuth(),
  validate({ params: linkServerParamsSchema }),
  controller.getLinkOne,
);

// ── Pack lang + icon pipeline (literal /packs routes BEFORE /:server) ───────

biforestingRouter.put(
  '/packs/:pack/lang',
  apiKeyAuth(),
  json({ limit: '8mb' }), // lang maps run to thousands of entries
  validate({ params: packParamsSchema, body: packLangBodySchema }),
  asyncHandler(controller.putPackLang),
);

biforestingRouter.post(
  '/packs/:pack/icons',
  apiKeyAuth(),
  json({ limit: '16mb' }), // a batch of base64 PNGs
  validate({ params: packParamsSchema, body: iconsUploadBodySchema }),
  asyncHandler(controller.postPackIcons),
);

biforestingRouter.get(
  '/packs/:pack/icons',
  apiKeyAuth(),
  validate({ params: packParamsSchema }),
  asyncHandler(controller.getPackIconInfo),
);

biforestingRouter.get(
  '/packs/:pack/icons/:id',
  apiKeyAuth(),
  validate({ params: packIconParamsSchema }),
  asyncHandler(controller.getPackIcon),
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
  '/ops/:opId/resume',
  apiKeyAuth(),
  validate({ params: opIdParamsSchema }),
  asyncHandler(controller.resumeOp),
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

// ── Profiler (profiler plan phase 4; literal /profiles route BEFORE /:server) ─

biforestingRouter.get(
  '/profiles/hotspots',
  apiKeyAuth(),
  validate({ query: fleetHotspotsQuerySchema }),
  asyncHandler(profiles.getFleetHotspots),
);

biforestingRouter.post(
  '/:server/profiles',
  apiKeyAuth(),
  validate({ params: linkServerParamsSchema, body: profileCaptureBodySchema }),
  asyncHandler(profiles.createCapture),
);

biforestingRouter.get(
  '/:server/profiles',
  apiKeyAuth(),
  validate({ params: linkServerParamsSchema, query: profileListQuerySchema }),
  asyncHandler(profiles.listCaptures),
);

biforestingRouter.get(
  '/:server/profiles/:captureId',
  apiKeyAuth(),
  validate({ params: profileParamsSchema }),
  asyncHandler(profiles.getCapture),
);

biforestingRouter.post(
  '/:server/profiles/:captureId/perfetto-link',
  apiKeyAuth(),
  validate({ params: profileParamsSchema }),
  asyncHandler(profiles.createPerfettoLink),
);

// Browser page: the view token in `t` authenticates it, since a browser tab sends no API key.
biforestingRouter.get(
  '/:server/profiles/:captureId/perfetto',
  validate({ params: profileParamsSchema, query: profileViewQuerySchema }),
  profiles.getPerfettoPage,
);

biforestingRouter.get(
  '/:server/profiles/:captureId/:artifact',
  profileTraceAuth(),
  validate({ params: profileArtifactParamsSchema }),
  asyncHandler(profiles.getArtifact),
);

// Upload from a linked server: upload token + authKey HMAC, no API key. Raw streamed body.
biforestingRouter.put(
  '/:server/profiles/:captureId/:artifact',
  validate({ params: profileArtifactParamsSchema }),
  asyncHandler(profiles.putArtifact),
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

// ── Item registry (phase 8) ──────────────────────────────────────────────────

biforestingRouter.get(
  '/:server/items',
  apiKeyAuth(),
  validate({ params: linkServerParamsSchema, query: itemSearchQuerySchema }),
  asyncHandler(controller.searchItems),
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
