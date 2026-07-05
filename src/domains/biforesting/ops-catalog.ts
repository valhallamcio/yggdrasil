import { z } from 'zod';

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
  description: string;
}

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
      })
      .strict(),
    serverGlobal: false,
    risk: 'reversible',
    description: 'Give items to a player (NBT items: use run_command /give until phase 8). Queues for next login when offline.',
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
    params: z.object({ questId: z.string().min(1).max(64).optional() }).strict(),
    serverGlobal: false,
    risk: 'dangerous',
    description: 'Reset quest progress for a player — omitting questId resets ALL quests.',
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
