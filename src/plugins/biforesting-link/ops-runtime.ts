import { getDb } from '../../core/database/client.js';
import { biforestingLinkManager } from './link-manager.js';
import { OpDispatcher } from './op-dispatcher.js';
import { OpsStore } from './ops-store.js';

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
});
