import { z } from 'zod';
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
