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
};

export function catalogEntry(type: string): OpCatalogEntry | undefined {
  return OPS_CATALOG[type];
}
