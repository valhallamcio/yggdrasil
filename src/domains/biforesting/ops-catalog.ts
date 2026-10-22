import { z } from 'zod';
import { UUID_RE } from '../../plugins/biforesting-link/decoders.js';
import { CAPTURE_ID_RE, PROFILE_ARTIFACT_NAMES } from '../../plugins/biforesting-link/profile-upload.js';

/**
 * Catalog of op types the REST API accepts — each entry validates `params` and declares dispatch
 * semantics. Risk tiers follow `ticket-research/fix-recipes.json` (`safe|reversible|confirm|dangerous`);
 * later phases (player/quest/team ops) add entries here rather than new endpoints.
 */

export interface OpCatalogEntry {
  params: z.ZodTypeAny;
  /** Op acts on the whole server — no player target required. */
  serverGlobal: boolean;
  risk: 'safe' | 'reversible' | 'confirm' | 'dangerous';
  /** Apply (non-dry-run) must reference a fresh completed dry-run of the same type+target. */
  requiresDryRunConfirm?: boolean;
  /**
   * Create requires an explicit `flags.confirm: true` — the server-side half of the Discord
   * confirmation flow, so a raw REST caller can't fire a dangerous op by accident.
   */
  requiresConfirm?: boolean;
  /** A fresh inspect_inventory snapshot is auto-prepended before a directly-created apply. */
  autoSnapshot?: boolean;
  /**
   * Policy feature (a `FEATURE_BITS` name) the server must have. Create is refused without it,
   * and the dispatcher fails a pending op of this type when the bit is gone at dispatch time.
   */
  requiresFeature?: string;
  /**
   * Only Yggdrasil itself creates ops of this type (the player sync runner). The generic
   * `POST /:server/ops` route refuses them with a 400.
   */
  internal?: boolean;
  description: string;
}

/**
 * A stack's tag for give_item/take_item: base64 of an uncompressed binary NBT compound. Binary NBT
 * keeps every tag type exactly on every era, which SNBT does not (1.7.10's parser has no byte arrays).
 * 256k chars is ~192 KB of NBT and stays well under the 1 MB request body limit.
 */
const itemNbt = z
  .string()
  .min(4)
  .max(262_144)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'nbt must be base64');

export const PROFILE_LEVELS = ['l0', 'l1', 'l2'] as const;
export const PROFILE_SAMPLERS = ['none', 'java', 'jfr'] as const;

/**
 * profile_fetch params: a capture already on the server's disk (a spike dump, a command capture, a
 * capture whose upload failed). No artifacts means every artifact that exists. Yggdrasil adds
 * `uploadToken` (bound to this captureId) and `uploadUrl` at dispatch.
 */
export const profileFetchParams = z
  .object({
    captureId: z
      .string()
      .regex(CAPTURE_ID_RE, 'captureId must match [A-Za-z0-9._-]{1,128}')
      .refine((v) => v !== '.' && v !== '..', 'captureId must name a capture directory'),
    artifacts: z.array(z.enum(PROFILE_ARTIFACT_NAMES)).min(1).max(PROFILE_ARTIFACT_NAMES.length).optional(),
  })
  .strict();

/** profile_capture params. Yggdrasil adds `uploadToken` and `uploadUrl` at dispatch. */
export const profileCaptureParams = z
  .object({
    seconds: z.number().int().min(1).max(600).default(30),
    level: z.enum(PROFILE_LEVELS).default('l1'),
    sampler: z.enum(PROFILE_SAMPLERS).default('java'),
  })
  .strict();

// ── Player sync ops (bifrost-lib docs/invariants/player-sync.md 3.5) ─────────

const syncGroup = z.string().min(1).max(64);
const syncMoveId = z.string().min(1).max(64);
const syncVersion = z.number().int().min(0);
/** A Pterodactyl serverId. Empty when the player has no owner (a stuck move). */
const syncServerId = z.string().max(64);
const syncLabel = z.string().max(64);
const syncMoveParams = z.object({ group: syncGroup, moveId: syncMoveId, v: syncVersion, to: syncServerId, toLabel: syncLabel }).strict();

/** Most entries a single `sync_disown` op carries. */
export const SYNC_DISOWN_MAX_ENTRIES = 500;
/** Most entries a single `sync_own` op carries. */
export const SYNC_OWN_MAX_ENTRIES = 500;
/** Most entries a single `sync_lock` op carries. */
export const SYNC_LOCK_MAX_ENTRIES = 500;

const SYNC_OPS: Record<string, OpCatalogEntry> = {
  sync_probe: {
    params: z.object({ group: syncGroup }).strict(),
    serverGlobal: false,
    risk: 'safe',
    requiresFeature: 'player_sync',
    internal: true,
    description: 'Player sync: read the online state, the .dat stamp, the fingerprint, the local move marks and the world-data locks of one player. Changes nothing.',
  },
  sync_prepare: {
    params: syncMoveParams,
    serverGlobal: false,
    risk: 'reversible',
    requiresFeature: 'player_sync',
    internal: true,
    description: 'Player sync on the source: scan the carried items. On a pass, refuse the player login there until the move ends.',
  },
  sync_release: {
    params: syncMoveParams,
    serverGlobal: false,
    risk: 'dangerous',
    requiresFeature: 'player_sync',
    internal: true,
    description: 'Player sync on the source: export the carried state of an offline player, stamp the .dat, send the release syncsnap.',
  },
  sync_apply: {
    params: z
      .object({ group: syncGroup, moveId: syncMoveId, v: syncVersion, sha256: z.string().regex(/^[0-9a-f]{64}$/), fp: z.string().max(128), snapshotId: z.string().min(1).max(256) })
      .strict(),
    serverGlobal: false,
    risk: 'dangerous',
    requiresFeature: 'player_sync',
    internal: true,
    description: 'Player sync on the target: write the carried state of a release snapshot into the offline player .dat. The blob is attached at dispatch; snapshotId stays in Yggdrasil.',
  },
  sync_commit: {
    params: z.object({ group: syncGroup, moveId: syncMoveId, v: syncVersion }).strict(),
    serverGlobal: false,
    risk: 'reversible',
    requiresFeature: 'player_sync',
    internal: true,
    description: 'Player sync on the source after the target applied: delete the exported world-data records and end the local move mark.',
  },
  sync_abort: {
    params: z.object({ group: syncGroup, moveId: syncMoveId }).strict(),
    serverGlobal: false,
    risk: 'reversible',
    requiresFeature: 'player_sync',
    internal: true,
    description: 'Player sync on the source: undo the local marks of a move that stopped.',
  },
  sync_kick: {
    params: z.object({ group: syncGroup, message: z.string().min(1).max(256), to: syncServerId, toLabel: syncLabel }).strict(),
    serverGlobal: false,
    risk: 'safe',
    requiresFeature: 'player_sync',
    internal: true,
    description: 'Player sync: disconnect a player who is online on an instance that does not own the character.',
  },
  sync_disown: {
    params: z
      .object({
        group: syncGroup,
        entries: z
          .array(z.object({ u: z.string().min(1).max(64), v: syncVersion, to: syncServerId, toLabel: syncLabel }).strict())
          .min(1)
          .max(SYNC_DISOWN_MAX_ENTRIES),
      })
      .strict(),
    serverGlobal: true,
    risk: 'reversible',
    requiresFeature: 'player_sync',
    internal: true,
    description: 'Player sync: mark players as away on this instance, so their local copy is refused at login.',
  },
  sync_own: {
    params: z
      .object({
        group: syncGroup,
        entries: z
          .array(z.object({ u: z.string().min(1).max(64), v: syncVersion }).strict())
          .min(1)
          .max(SYNC_OWN_MAX_ENTRIES),
      })
      .strict(),
    serverGlobal: true,
    risk: 'reversible',
    requiresFeature: 'player_sync',
    internal: true,
    description: 'Player sync after a restore: this instance owns these players, so clear the away and moving marks that the restore brought back. Writes no .dat.',
  },
  sync_lock: {
    params: z
      .object({
        group: syncGroup,
        entries: z
          .array(
            z
              .object({
                h: z.string().regex(/^[a-z0-9_.-]{1,64}$/),
                key: z.string().min(1).max(256),
                to: syncServerId,
                toLabel: syncLabel,
              })
              .strict(),
          )
          .min(1)
          .max(SYNC_LOCK_MAX_ENTRIES),
      })
      .strict(),
    serverGlobal: true,
    risk: 'reversible',
    requiresFeature: 'player_sync',
    internal: true,
    description:
      'Player sync after a restore: another instance owns these world-data records, or they are in transit, so this instance refuses to open them (lock state foreign). Reads and writes no record.',
  },
};

// ── Quest progress ops (Phase 6: valhallamc-work evol-multi-instance-2026-10/phase6/DESIGN.md 7) ──

const questUuid = z.string().regex(UUID_RE, 'must be a dashed UUID');

export const QUEST_ACTIONS = ['pref', 'fresh', 'leave', 'undo'] as const;
export const QUEST_PREFS = ['merge', 'separate'] as const;

/** A backup id names one local backup directory on the instance. */
export const questBackupId = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,128}$/, 'backupId must match [A-Za-z0-9._-]{1,128}')
  .refine((v) => v !== '.' && v !== '..', 'backupId must name a backup');

/** The fields of one `/quests` menu action, shared by the REST body and the op params. */
export const questActionFields = {
  action: z.enum(QUEST_ACTIONS),
  value: z.enum(QUEST_PREFS).optional(),
  backupId: questBackupId.optional(),
};

/** `pref` needs a value. Only `undo` takes a backupId. No other action takes either. */
export function questActionRule(b: { action: (typeof QUEST_ACTIONS)[number]; value?: unknown; backupId?: unknown }, ctx: z.RefinementCtx): void {
  if (b.action === 'pref' && b.value === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'pref needs a value' });
  if (b.action !== 'pref' && b.value !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: `${b.action} takes no value` });
  if (b.action !== 'undo' && b.backupId !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['backupId'], message: `${b.action} takes no backupId` });
  }
}

const QUEST_OPS: Record<string, OpCatalogEntry> = {
  quests_status: {
    params: z.object({ group: syncGroup, uuid: questUuid }).strict(),
    serverGlobal: false,
    risk: 'safe',
    requiresFeature: 'player_sync',
    internal: true,
    description: 'Quest progress: the book of a player on this instance (solo or party), quests done, the pref and the newest local backups. Changes nothing.',
  },
  quests_action: {
    params: z
      .object({ group: syncGroup, uuid: questUuid, ...questActionFields })
      .strict()
      .superRefine(questActionRule),
    serverGlobal: false,
    risk: 'reversible',
    requiresFeature: 'player_sync',
    internal: true,
    description: 'Quest progress: one /quests menu action (pref, fresh, leave, undo). The mod backs up every file it changes first.',
  },
  quests_party_candidates: {
    params: z.object({ group: syncGroup, uuid: questUuid }).strict(),
    serverGlobal: false,
    risk: 'safe',
    requiresFeature: 'player_sync',
    internal: true,
    description: 'Quest progress: the parties on this instance that hold the player, with members and quests done. Changes nothing.',
  },
  quests_export_party: {
    params: z.object({ group: syncGroup, teamId: questUuid }).strict(),
    serverGlobal: true,
    risk: 'safe',
    requiresFeature: 'player_sync',
    internal: true,
    description:
      'Quest progress: export the book of one party on this instance for quests_import_party. Read only. The record goes up as a party_export syncsnap; the result names it by sha256.',
  },
  quests_import_party: {
    params: z
      .object({
        group: syncGroup,
        uuid: questUuid,
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        snapshotId: z.string().min(1).max(256),
        sourceServerId: z.string().min(1).max(64),
        sourceTeamId: questUuid,
      })
      .strict(),
    serverGlobal: false,
    risk: 'reversible',
    requiresFeature: 'player_sync',
    internal: true,
    description:
      "Quest progress: merge an exported party book into the player's current party on this instance (party owner only). The mod backs up the book first. The party_export blob is attached at dispatch; snapshotId stays in Yggdrasil.",
  },
};

export const OPS_CATALOG: Record<string, OpCatalogEntry> = {
  echo: {
    params: z.object({ message: z.string().min(1).max(4096) }).strict(),
    serverGlobal: true,
    risk: 'safe',
    description: 'Round-trip test — the mod echoes the message back in the result.',
  },
  run_command: {
    params: z.object({ command: z.string().min(1).max(4096) }).strict(),
    serverGlobal: true,
    risk: 'confirm',
    description: 'Run a console command on the backend with captured output.',
  },
  registry_spike: {
    params: z.object({}).strict(),
    serverGlobal: true,
    risk: 'safe',
    description: '1.7.10 diagnostic: reflective getSubItems yield over the item registry (plan risk R1).',
  },
  pull_item_registry: {
    params: z.object({}).strict(),
    serverGlobal: true,
    risk: 'safe',
    description: 'Re-dump the item registry (id/mod/display/maxStack + metaitem variants) to Yggdrasil — also fired automatically on CAP_REGISTRY_EXPORT grant. The registry is frozen at boot, so a re-dump is only needed after a pack update.',
  },
  inspect_inventory: {
    params: z.object({}).strict(),
    serverGlobal: false,
    risk: 'safe',
    description: 'Display-ready item list for an online player; offline target parks as waiting_player (offline read lands in phase 5).',
  },
  remove_item: {
    params: z
      .object({
        id: z.string().min(1).max(256),
        meta: z.number().int().min(0).max(65535).optional(),
        nbtContains: z.string().min(1).max(256).optional(),
        slots: z.enum(['main', 'armor', 'offhand', 'ender', 'all']).optional(),
        count: z.number().int().min(1).optional(),
        countMode: z.enum(['all', 'exact', 'atMost']).optional(),
      })
      .strict(),
    serverGlobal: false,
    risk: 'reversible',
    requiresDryRunConfirm: true,
    description: 'Remove matching items from a player (dry-run plans; apply mutates + resyncs; exact-shortfall = no-op fail).',
  },
  give_item: {
    params: z
      .object({
        id: z.string().min(1).max(256),
        meta: z.number().int().min(0).max(65535).optional(),
        count: z.number().int().min(1).max(2304).optional(),
        overflow: z.enum(['drop', 'fail']).optional(),
        nbt: itemNbt.optional(),
      })
      .strict(),
    serverGlobal: false,
    risk: 'reversible',
    description:
      "Give items to a player. `nbt` is the stack's tag as base64 binary NBT (from 1.20.5 the components compound). Queues for next login when offline.",
  },
  take_item: {
    params: z
      .object({
        id: z.string().min(1).max(256),
        meta: z.number().int().min(0).max(65535).optional(),
        count: z.number().int().min(1).max(2304),
        nbt: itemNbt.optional(),
        num: z.number().int().min(0).max(2_147_483_647).optional(),
      })
      .strict(),
    serverGlobal: false,
    risk: 'reversible',
    description:
      "Take exactly `count` of one item from an ONLINE player's main inventory, all or nothing. A stack matches on registry id, damage, and a tag equal to `nbt` (no `nbt` = no tag). `num` also pins the numeric id this backend uses. Result `{player, requested, taken, removed}`; a shortfall fails with code `not_applied` and takes nothing.",
  },
  take_slot: {
    params: z
      .object({
        slot: z.number().int().min(0).max(35),
        id: z.string().min(1).max(256),
        count: z.number().int().min(1).max(2304),
        num: z.number().int().min(0).max(2_147_483_647).optional(),
      })
      .strict(),
    serverGlobal: false,
    risk: 'reversible',
    requiresFeature: 'take_slot',
    description:
      "Take `count` from one main-inventory slot of an ONLINE player (`slot` 0-8 hotbar, 9-35 main), all or nothing. The stack must have the registry id (and `num`, when given) and at least `count` items. Result `{player, requested, taken, slot, nbt?}`: `nbt` is the stack's data as base64 binary NBT in the format give_item reads, absent when the stack has none. A refusal fails with code `not_applied` and takes nothing.",
  },
  teleport: {
    params: z
      .object({
        mode: z.enum(['spawn', 'pos']).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        z: z.number().optional(),
      })
      .strict(),
    serverGlobal: false,
    risk: 'safe',
    description: 'Teleport a player to spawn (crash-rescue; no-portal path on legacy) or to a position in their current dim.',
  },
  heal: {
    params: z.object({}).strict(),
    serverGlobal: false,
    risk: 'safe',
    description: 'Full health + food.',
  },
  set_gamemode: {
    params: z.object({ mode: z.enum(['survival', 'creative', 'adventure', 'spectator']) }).strict(),
    serverGlobal: false,
    risk: 'confirm',
    description: 'Set a player gamemode (spectator rejected by 1.7.10 backends).',
  },
  pull_quest_registry: {
    params: z.object({}).strict(),
    serverGlobal: true,
    risk: 'safe',
    description: 'Re-dump the quest registry (FTBQ/BQ) to Yggdrasil — also fired automatically on CAP_QUEST_OPS grant.',
  },
  quest_complete: {
    params: z.object({ questId: z.string().min(1).max(64) }).strict(),
    serverGlobal: false,
    risk: 'confirm',
    description: 'Complete a quest for a player (command fallback, output captured; offline target parks as waiting_player).',
  },
  task_complete: {
    params: z.object({ questId: z.string().min(1).max(64) }).strict(),
    serverGlobal: false,
    risk: 'confirm',
    description: 'Complete a single task by its id (FTBQ task ids share the quest id space; BQ treats it as quest complete).',
  },
  quest_reset: {
    requiresConfirm: true,
    params: z.object({ questId: z.string().min(1).max(64).optional() }).strict(),
    serverGlobal: false,
    risk: 'dangerous',
    description: 'Reset quest progress for a player — omitting questId resets ALL quests.',
  },
  team_reset: {
    requiresConfirm: true,
    params: z.object({}).strict(),
    serverGlobal: false,
    risk: 'dangerous',
    description: 'Kick the player to a solo team (party owner → whole party force-disbanded; SU multi-member owner is refused). Transfer claims FIRST.',
  },
  claims_transfer: {
    params: z.object({ holdTeam: z.string().min(1).max(64).optional() }).strict(),
    serverGlobal: false,
    risk: 'confirm',
    description: "Move every claim of the player's team to the server-owned hold team (default 'valhallamc', created on demand) keeping force-load state (D15).",
  },
  claims_release: {
    requiresConfirm: true,
    params: z.object({}).strict(),
    serverGlobal: false,
    risk: 'dangerous',
    description: "Unclaim everything the player's team owns (prefer claims_transfer — no-grief default).",
  },
  inventory_clear: {
    requiresConfirm: true,
    autoSnapshot: true,
    params: z.object({}).strict(),
    serverGlobal: false,
    risk: 'dangerous',
    description: 'Empty main+armor+offhand+ender inventory of an ONLINE player (account_reset snapshots first).',
  },
  restore_inventory: {
    requiresConfirm: true,
    autoSnapshot: true,
    params: z
      .object({
        snapshotId: z.string().min(1).max(64),
        mode: z.enum(['replace', 'fill']).optional(),
        slots: z.array(z.number().int().min(0).max(1023)).min(1).max(256).optional(),
      })
      .strict(),
    serverGlobal: false,
    risk: 'dangerous',
    description:
      'Put a player back exactly as a snapshot had them — slot-exact, armor in armor slots, full NBT. mode=replace (default) overwrites the inventory; mode=fill only touches slots that are now empty; slots[] restricts it to specific slots (ender = 100+i). The gz blob is attached at dispatch; a pre-restore snapshot is auto-taken so it can be undone.',
  },
  profile_capture: {
    params: profileCaptureParams,
    serverGlobal: true,
    risk: 'safe',
    requiresFeature: 'profiler',
    description:
      'Record a profiler capture and upload its artifacts to /v1/biforesting/:server/profiles. Tier B (level l0/l1, at most 60 s, 1 per server per 30 min) runs without confirm. Anything else needs flags.confirm: true.',
  },
  profile_stop: {
    params: z.object({}).strict(),
    serverGlobal: true,
    risk: 'safe',
    requiresFeature: 'profiler',
    description: 'Stop the running profiler capture early. The mod still writes and uploads its artifacts.',
  },
  profile_fetch: {
    params: profileFetchParams,
    serverGlobal: true,
    risk: 'safe',
    requiresFeature: 'profiler',
    description:
      'Upload the artifacts of a capture that is already on the server (spike dumps, command captures, failed uploads) to /v1/biforesting/:server/profiles. The result lists uploaded, missing, alreadyStored and uploadErrors.',
  },
  // bifrost-lib docs/invariants/end-reset.md. The mod gates it by the ops bit only.
  end_reset_plan: {
    params: z.object({}).strict(),
    serverGlobal: true,
    risk: 'safe',
    description:
      'End reset dry run. The mod reads the End files on disk on a worker thread and writes config/biforesting/end-reset/plan.json. It changes nothing else. The result holds planId, planSha256, path, totals, unsupported and backupBytes.',
  },
  account_reset: {
    requiresConfirm: true,
    params: z
      .object({
        holdTeam: z.string().min(1).max(64).optional(),
        claims: z.enum(['transfer', 'release']).optional(),
      })
      .strict(),
    serverGlobal: false,
    risk: 'dangerous',
    description: 'COMPOUND: snapshot → quest_reset(all) → claims transfer/release → team_reset → inventory_clear; fails at checkpoint, resumable via /ops/:id/resume.',
  },
  ...SYNC_OPS,
  ...QUEST_OPS,
};

export const DRY_RUN_CONFIRM_WINDOW_MS = 15 * 60_000;

/**
 * Destructive-apply guard predicate (pure — unit-tested): null when the referenced dry-run
 * authorizes this apply, else a human-readable rejection reason.
 */
export function dryRunConfirmError(
  dry: {
    state: string;
    type: string;
    instanceKey: string;
    flags: { dryRun?: boolean };
    target: { uuid?: string; name?: string } | null;
    completedAt: Date | null;
  } | null,
  apply: { type: string; instanceKey: string; target: { uuid?: string; name?: string } | null },
  now = Date.now(),
): string | null {
  if (!dry) return 'referenced dry-run op not found';
  if (dry.state !== 'completed') return `referenced dry-run is ${dry.state}, not completed`;
  if (dry.type !== apply.type) return 'dry-run type differs from the apply type';
  if (dry.instanceKey !== apply.instanceKey) return 'dry-run ran against a different server';
  if (dry.flags?.dryRun !== true) return 'referenced op was not a dry-run';
  const sameTarget =
    !!dry.target &&
    !!apply.target &&
    ((!!dry.target.uuid && dry.target.uuid === apply.target.uuid) ||
      (!!dry.target.name && !!apply.target.name && dry.target.name.toLowerCase() === apply.target.name.toLowerCase()));
  if (!sameTarget) return 'dry-run targeted a different player';
  if (dry.completedAt === null || now - new Date(dry.completedAt).getTime() >= DRY_RUN_CONFIRM_WINDOW_MS) {
    return 'dry-run is older than 15 min — re-run it';
  }
  return null;
}

export function catalogEntry(type: string): OpCatalogEntry | undefined {
  return OPS_CATALOG[type];
}
