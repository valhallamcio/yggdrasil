import { z } from 'zod';
import { UUID_RE } from '../../plugins/biforesting-link/decoders.js';
import { SYNC_MODES } from '../../plugins/biforesting-link/sync-groups-store.js';
import { MOVE_STEPS } from '../../plugins/biforesting-link/sync-moves-store.js';
import { questActionFields, questActionRule } from './ops-catalog.js';

/** Player sync REST (bifrost-lib `docs/invariants/player-sync.md` section 7). */

const groupName = z.string().min(1).max(64);
/** A Pterodactyl serverId, never a tag or an instanceKey. */
const serverId = z.string().min(1).max(64);
const playerUuid = z
  .string()
  .regex(UUID_RE, 'uuid must be a dashed UUID')
  .transform((u) => u.toLowerCase());

export const syncGroupParamsSchema = z.object({ group: groupName });

export const syncPlayerParamsSchema = z.object({ group: groupName, uuid: playerUuid });

/** At least one field. `holdMs` stays within the 15 s long-poll cap of the move routes. */
export const syncGroupPutBodySchema = z
  .object({
    mode: z.enum(SYNC_MODES).optional(),
    frozen: z.boolean().optional(),
    freezeReason: z.string().max(200).nullable().optional(),
    cooldownMs: z.number().int().min(0).max(7 * 24 * 3600_000).optional(),
    holdMs: z.number().int().min(0).max(15_000).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'no group fields to update' });

export const shadowMoveBodySchema = z
  .object({ from: serverId, to: serverId })
  .strict()
  .refine((b) => b.from !== b.to, { message: 'from and to must be different instances' });

export const syncSnapshotListQuerySchema = z.object({
  kind: z.enum(['shadow', 'release', 'pre_sync', 'pre_action']).optional(),
});

/** POST .../quests/action. The op goes to the owner instance (phase6 DESIGN 4 and 7). */
export const syncQuestActionBodySchema = z.object(questActionFields).strict().superRefine(questActionRule);

/** POST .../quests/party-merge. `fromServer` holds the party `teamId`; the owner instance imports it. */
export const syncQuestMergeBodySchema = z.object({ fromServer: serverId, teamId: playerUuid }).strict();

/** `<group>:<uuid>:<v>:<kind>:<serverId>`. */
export const syncSnapshotIdParamsSchema = z.object({
  id: z.string().min(1).max(256),
});

export const syncMoveParamsSchema = z.object({ group: groupName, uuid: playerUuid, moveId: z.string().min(1).max(64) });

/** POST .../moves. `from` is the instance the player is on now. */
export const syncMoveStartBodySchema = z
  .object({
    from: serverId,
    to: serverId,
    name: z.string().min(1).max(64).optional(),
    reason: z.string().max(200).optional(),
    /** The caller (Bifrost) checked staff rights. The move ignores the group cooldown. */
    skipCooldown: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.from !== b.to, { message: 'from and to must be different instances' });

/**
 * GET .../moves/:moveId. `waitMs` makes it a long poll. `step` is the step the caller saw last:
 * when the move has moved past it, the answer comes at once.
 */
export const syncMoveWaitQuerySchema = z.object({
  waitMs: z.coerce.number().int().min(0).max(15_000).default(0),
  step: z.enum(MOVE_STEPS).optional(),
});

export const syncMoveListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const syncForceReleaseBodySchema = z
  .object({ to: serverId, snapshotId: z.string().min(1).max(256).optional() })
  .strict();

/** POST /sync/:group/reseed. `serverId` is the restored instance. */
export const syncReseedBodySchema = z.object({ serverId }).strict();

export type SyncGroupParams = z.infer<typeof syncGroupParamsSchema>;
export type SyncMoveParams = z.infer<typeof syncMoveParamsSchema>;
export type SyncMoveStartBody = z.infer<typeof syncMoveStartBodySchema>;
export type SyncMoveWaitQuery = z.infer<typeof syncMoveWaitQuerySchema>;
export type SyncMoveListQuery = z.infer<typeof syncMoveListQuerySchema>;
export type SyncForceReleaseBody = z.infer<typeof syncForceReleaseBodySchema>;
export type SyncReseedBody = z.infer<typeof syncReseedBodySchema>;
export type SyncPlayerParams = z.infer<typeof syncPlayerParamsSchema>;
export type SyncGroupPutBody = z.infer<typeof syncGroupPutBodySchema>;
export type ShadowMoveBody = z.infer<typeof shadowMoveBodySchema>;
export type SyncSnapshotListQuery = z.infer<typeof syncSnapshotListQuerySchema>;
export type SyncSnapshotIdParams = z.infer<typeof syncSnapshotIdParamsSchema>;
export type SyncQuestActionBody = z.infer<typeof syncQuestActionBodySchema>;
export type SyncQuestMergeBody = z.infer<typeof syncQuestMergeBodySchema>;
