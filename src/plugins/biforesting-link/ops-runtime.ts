import { getDb } from '../../core/database/client.js';
import { logger } from '../../core/logger/index.js';
import { biforestingLinkManager } from './link-manager.js';
import { CompoundOps } from './compound-ops.js';
import { OpDispatcher } from './op-dispatcher.js';
import { OpsStore } from './ops-store.js';
import type { OpDoc } from './types.js';

/**
 * Production singletons for the durable ops layer. The store resolves the Db lazily per call
 * (never a captured handle) and the dispatcher reaches live links through the link manager.
 * Started/stopped by the biforesting-link plugin's init/shutdown, which also wires the manager's
 * OpSink to the dispatcher.
 */
export const opsStore = new OpsStore(() => getDb());

export const opDispatcher = new OpDispatcher(opsStore, {
  sendDown: (instanceKey, channel, payload) => biforestingLinkManager.sendDown(instanceKey, channel, payload),
  liveInstanceKeys: () => biforestingLinkManager.liveInstanceKeys(),
  linkServerIdFor: (instanceKey): string | null => biforestingLinkManager.getSessionByServer(instanceKey)?.identity?.linkServerId ?? null,
});

export const compoundOps = new CompoundOps(opsStore, opDispatcher);

/**
 * The dispatcher has one update hook. This fan-out feeds every op update to the compound runner
 * and to each hook added with {@link addOpUpdateHook} (the player sync runner).
 */
const updateHooks: Array<(op: OpDoc) => Promise<void>> = [(op): Promise<void> => compoundOps.onChildUpdate(op)];

export function addOpUpdateHook(hook: (op: OpDoc) => Promise<void>): void {
  updateHooks.push(hook);
}

/** Runs every update hook. A failing hook logs and never stops the others. */
export async function fanOutOpUpdate(op: OpDoc): Promise<void> {
  const results = await Promise.allSettled(updateHooks.map(async (hook) => hook(op)));
  for (const r of results) {
    if (r.status === 'rejected') logger.warn({ err: r.reason as unknown, opId: op._id }, 'biforesting-ops: update hook failed');
  }
}

opDispatcher.setUpdateHook(fanOutOpUpdate);
