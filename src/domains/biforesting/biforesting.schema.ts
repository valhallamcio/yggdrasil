import { z } from 'zod';
import { profileCaptureParams } from './ops-catalog.js';
import { CAPTURE_ID_RE, PROFILE_ARTIFACT_NAMES, PROFILE_KINDS } from '../../plugins/biforesting-link/profile-upload.js';
import { FIX_ID_RE, MAX_ENABLED_FIXES, MAX_FIX_ID_LENGTH } from '../../plugins/biforesting-link/policy-store.js';

/** A server identifier in the URL: link serverId, Pterodactyl serverId, tag, or instanceKey (`tag:id`). */
export const linkServerParamsSchema = z.object({
  server: z.string().min(1).max(64),
});

// ── Inventory snapshots (phase 4, plan D12) ──────────────────────────────────

export const playerInvParamsSchema = z.object({
  server: z.string().min(1).max(64),
  player: z.string().min(1).max(36),
});

export const snapshotIdParamsSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{24}$/i, 'snapshot id must be a Mongo ObjectId'),
});

// ── Quest registry search (phase 6) ─────────────────────────────────────────

export const questSearchQuerySchema = z.object({
  search: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ── Item registry search (phase 8) ──────────────────────────────────────────

export const itemSearchQuerySchema = z.object({
  search: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

// ── Pack lang + icons (phase 8 pipeline) ─────────────────────────────────────

export const packParamsSchema = z.object({
  pack: z.string().min(1).max(64),
});

export const packIconParamsSchema = z.object({
  pack: z.string().min(1).max(64),
  id: z.string().min(1).max(256),
});

export const packLangBodySchema = z.object({
  // key → value; big maps (thousands of entries) are fine — stored as one doc.
  lang: z.record(z.string(), z.string()),
});

export const iconsUploadBodySchema = z.object({
  // base64-encoded PNGs, chunked by the upload script (≤200/batch keeps a request well under the
  // 16mb route limit; item icons are tiny — a 64px PNG is a few KB).
  icons: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        pngBase64: z.string().min(1).max(262_144),
      }),
    )
    .min(1)
    .max(200),
});

// ── Metrics history (v2, plan D13) ───────────────────────────────────────────

export const metricsHistoryQuerySchema = z.object({
  res: z.enum(['raw', 'hourly']).default('raw'),
  sinceHours: z.coerce.number().int().min(1).max(720).optional(),
});

// ── Durable ops ──────────────────────────────────────────────────────────────

export const opIdParamsSchema = z.object({
  opId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'opId must be a ULID'),
});

/** POST body for op creation. `params` is validated per-type against the ops catalog. */
export const opCreateBodySchema = z.object({
  type: z.string().min(1).max(64),
  params: z.record(z.unknown()).default({}),
  target: z
    .object({
      uuid: z.string().uuid().optional(),
      name: z.string().min(1).max(32).optional(),
    })
    .refine((t) => t.uuid !== undefined || t.name !== undefined, { message: 'target needs uuid or name' })
    .optional(),
  flags: z
    .object({
      offlineMode: z.enum(['queue', 'offline-edit', 'reject']).optional(),
      dryRun: z.boolean().optional(),
      /** Required true by requiresConfirm (dangerous) catalog entries — the REST half of the Discord confirm. */
      confirm: z.boolean().optional(),
    })
    .optional(),
  idempotencyKey: z.string().min(8).max(128).optional(),
  /** Required by requiresDryRunConfirm catalog entries when applying (non-dry-run). */
  confirmedFromDryRun: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
  notBefore: z.coerce.date().optional(),
  expiresInMs: z.number().int().min(60_000).max(30 * 24 * 3600_000).optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
  dispatchTimeoutMs: z.number().int().min(1_000).max(300_000).optional(),
  execTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
});

export const opListQuerySchema = z.object({
  state: z
    .enum(['pending', 'dispatched', 'acked', 'waiting_player', 'completed', 'failed', 'expired', 'cancelled'])
    .optional(),
  type: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const questDownBodySchema = z.object({
  teams: z
    .array(
      z.object({
        teamId: z.string().min(1),
        dataVersion: z.number().int().nonnegative(),
        snbt: z.string(),
      }),
    )
    .min(1),
});

export const chunksDownBodySchema = z.object({
  teams: z
    .array(
      z.object({
        teamId: z.string().min(1),
        claims: z.array(
          z.object({
            dimension: z.string().min(1),
            x: z.number().int(),
            z: z.number().int(),
            force: z.boolean(),
          }),
        ),
      }),
    )
    .min(1),
});

/**
 * Policy PUT body: grant features by NAME (see policy-store FEATURE_BITS) or as a raw bitmask;
 * exactly one of the two. Cadences are optional Hz fields consumed by the mod's features.
 */
export const policyPutBodySchema = z
  .object({
    features: z.array(z.string().min(1)).optional(),
    enabledFeatures: z.number().int().nonnegative().optional(),
    metricsHz: z.number().int().min(0).max(20).optional(),
    questHz: z.number().int().min(0).max(20).optional(),
    chunkHz: z.number().int().min(0).max(20).optional(),
    /** Fix ids the mod's runtime switch turns on. Replaces the stored list; `[]` turns every fix off. */
    enabledFixes: z
      .array(z.string().max(MAX_FIX_ID_LENGTH).regex(FIX_ID_RE, 'fix id must be lowercase modid-short-name'))
      .max(MAX_ENABLED_FIXES)
      .optional(),
  })
  .refine((b) => (b.features !== undefined) !== (b.enabledFeatures !== undefined) || (b.features === undefined && b.enabledFeatures === undefined), {
    message: 'provide features[] OR enabledFeatures, not both',
  });

// ── Profiler (profiler plan phase 4) ─────────────────────────────────────────

/** POST /:server/profiles. `confirm` becomes `flags.confirm` and lifts the tier B budget. */
export const profileCaptureBodySchema = profileCaptureParams.extend({ confirm: z.boolean().optional() }).strict();

export const profileParamsSchema = z.object({
  server: z.string().min(1).max(64),
  captureId: z.string().regex(CAPTURE_ID_RE, 'captureId must match [A-Za-z0-9._-]{1,128}'),
});

export const profileArtifactParamsSchema = profileParamsSchema.extend({
  artifact: z.enum(PROFILE_ARTIFACT_NAMES),
});

/** `kind=spike` lists spike catcher dumps only, `kind=capture` everything else. */
export const profileListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  kind: z.enum(PROFILE_KINDS).optional(),
});

export const fleetHotspotsQuerySchema = z.object({
  top: z.coerce.number().int().min(1).max(500).default(50),
  kind: z.string().min(1).max(64).optional(),
  mod: z.string().min(1).max(128).optional(),
});

/** `t` is a short-lived view token from POST .../perfetto-link. */
export const profileViewQuerySchema = z.object({
  t: z.string().min(1).max(2048).optional(),
});

export type LinkServerParams = z.infer<typeof linkServerParamsSchema>;
export type PolicyPutBody = z.infer<typeof policyPutBodySchema>;
export type QuestDownBody = z.infer<typeof questDownBodySchema>;
export type ChunksDownBody = z.infer<typeof chunksDownBodySchema>;
export type OpIdParams = z.infer<typeof opIdParamsSchema>;
export type OpCreateBody = z.infer<typeof opCreateBodySchema>;
export type OpListQuery = z.infer<typeof opListQuerySchema>;
export type MetricsHistoryQuery = z.infer<typeof metricsHistoryQuerySchema>;
export type PlayerInvParams = z.infer<typeof playerInvParamsSchema>;
export type SnapshotIdParams = z.infer<typeof snapshotIdParamsSchema>;
export type QuestSearchQuery = z.infer<typeof questSearchQuerySchema>;
export type ItemSearchQuery = z.infer<typeof itemSearchQuerySchema>;
export type PackParams = z.infer<typeof packParamsSchema>;
export type PackIconParams = z.infer<typeof packIconParamsSchema>;
export type PackLangBody = z.infer<typeof packLangBodySchema>;
export type IconsUploadBody = z.infer<typeof iconsUploadBodySchema>;
export type ProfileCaptureBody = z.infer<typeof profileCaptureBodySchema>;
export type ProfileParams = z.infer<typeof profileParamsSchema>;
export type ProfileArtifactParams = z.infer<typeof profileArtifactParamsSchema>;
export type ProfileListQuery = z.infer<typeof profileListQuerySchema>;
export type FleetHotspotsQuery = z.infer<typeof fleetHotspotsQuerySchema>;
export type ProfileViewQuery = z.infer<typeof profileViewQuerySchema>;
