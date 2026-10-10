import type { Db } from 'mongodb';
import { getDb } from '../../core/database/client.js';
import { biforestingLinkManager } from './link-manager.js';
import { addOpUpdateHook, opDispatcher, opsStore } from './ops-runtime.js';
import { getPolicy } from './policy-store.js';
import { serverResolver } from './server-resolver.js';
import { SyncGroupsStore } from './sync-groups-store.js';
import { SyncLedgerStore } from './sync-ledger-store.js';
import { SyncMovesStore } from './sync-moves-store.js';
import { SyncQuestMergesStore } from './sync-quest-merges-store.js';
import { SyncQuests } from './sync-quests.js';
import { SyncRunner, type SyncRunnerDirectory } from './sync-runner.js';
import { SyncShadowStore } from './sync-shadow-store.js';
import { SyncSnapshotStore } from './sync-snapshot-store.js';
import { SyncService, type SyncLinkPort } from './sync-service.js';
import { SyncWorldDataStore } from './sync-worlddata-store.js';

/**
 * Production singletons for player sync. The stores resolve the Db lazily per call, like
 * `ops-runtime.ts`. The plugin init ensures the indexes, wires the service into the link manager
 * as its sync sink and starts the move runner ({@link startSyncRunner}).
 */
const db = (): Db => getDb();

export const syncGroupsStore = new SyncGroupsStore(db);
export const syncLedgerStore = new SyncLedgerStore(db);
export const syncSnapshotStore = new SyncSnapshotStore(db, syncLedgerStore);
export const syncShadowStore = new SyncShadowStore(db);
export const syncMovesStore = new SyncMovesStore(db);
export const syncWorldDataStore = new SyncWorldDataStore(db);
export const syncQuestMergesStore = new SyncQuestMergesStore(db);

const links: SyncLinkPort = {
  instance: async (serverId) => {
    const live = biforestingLinkManager.liveInstance(serverId);
    if (!live) return null;
    const policy = await getPolicy(live.instanceKey);
    return {
      instanceKey: live.instanceKey,
      grantedFeatures: policy.enabledFeatures & live.capabilities,
      fp: live.sync?.fp ?? null,
    };
  },
};

/** Group membership from the server resolver. An instanceKey only for an exact serverId match. */
const directory: SyncRunnerDirectory = {
  groupOf: (serverId) => serverResolver.groupOf(serverId),
  groupMembers: (group) => serverResolver.groupMembers(group),
  instanceOf: async (serverId) => {
    const identity = await serverResolver.resolve(serverId);
    return identity.resolved && identity.serverId === serverId ? { instanceKey: identity.instanceKey, tag: identity.tag } : null;
  },
};

export const syncRunner = new SyncRunner({
  stores: { groups: syncGroupsStore, ledger: syncLedgerStore, snapshots: syncSnapshotStore, moves: syncMovesStore, worldData: syncWorldDataStore },
  ops: opsStore,
  dispatch: opDispatcher,
  directory,
  links,
});

export const syncQuests = new SyncQuests({
  stores: { groups: syncGroupsStore, ledger: syncLedgerStore, merges: syncQuestMergesStore },
  ops: opsStore,
  dispatch: opDispatcher,
  directory,
  links,
});

export const syncService = new SyncService(
  { groups: syncGroupsStore, ledger: syncLedgerStore, snapshots: syncSnapshotStore, shadow: syncShadowStore },
  serverResolver,
  links,
  syncRunner,
);

export async function ensureSyncIndexes(): Promise<void> {
  await syncGroupsStore.ensureIndexes();
  await syncLedgerStore.ensureIndexes();
  await syncSnapshotStore.ensureIndexes();
  await syncShadowStore.ensureIndexes();
  await syncMovesStore.ensureIndexes();
  await syncWorldDataStore.ensureIndexes();
  await syncQuestMergesStore.ensureIndexes();
}

let hooked = false;

/**
 * Feeds op updates to the move runner and to the quest calls that wait for an op result, gives
 * the dispatcher the `sync_apply` blob source and
 * starts the sweep and lease timers. With every group `off` the runner does no Mongo work after
 * its first sweep.
 */
export function startSyncRunner(): void {
  if (!hooked) {
    addOpUpdateHook((op) => syncRunner.onOpUpdate(op));
    addOpUpdateHook((op) => syncQuests.onOpUpdate(op));
    opDispatcher.setSyncSnapshots(syncSnapshotStore);
    hooked = true;
  }
  syncRunner.start();
}

export function stopSyncRunner(): void {
  syncRunner.stop();
}
