import type { Collection, Db } from 'mongodb';

/**
 * Per-group player sync settings in `biforesting_sync_groups` (bifrost-lib
 * `docs/invariants/player-sync.md` section 5). `_id` is the Bifrost group name. A group with no
 * doc reads as the defaults, so its mode is `off` and Yggdrasil does no sync work for it.
 *
 * Constructed with a Db provider like `OpsStore`, so tests point it at mem-mongo.
 *
 * {@link SyncGroupsStore.get} serves a doc from memory for {@link GROUP_CACHE_MS}, because the
 * presence path reads it on every event. An upsert through this store replaces the cached doc at
 * once. One Yggdrasil process is the assumption: another process sees a change up to 5 s late.
 */

export const SYNC_MODES = ['off', 'shadow', 'live'] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

export interface SyncGroupDoc {
  _id: string;
  mode: SyncMode;
  /** True refuses new moves. Open moves continue. */
  frozen: boolean;
  freezeReason: string | null;
  cooldownMs: number;
  /** How long Bifrost holds a login while a move runs. */
  holdMs: number;
  updatedAt?: Date;
  updatedBy?: string;
}

export type SyncGroupFields = Partial<Pick<SyncGroupDoc, 'mode' | 'frozen' | 'freezeReason' | 'cooldownMs' | 'holdMs'>>;

/** How long a group doc stays in the in-process cache. */
export const GROUP_CACHE_MS = 5_000;

export const SYNC_GROUP_DEFAULTS: Omit<SyncGroupDoc, '_id'> = {
  mode: 'off',
  frozen: false,
  freezeReason: null,
  cooldownMs: 600_000,
  holdMs: 10_000,
};

export class SyncGroupsStore {
  private readonly cache = new Map<string, { doc: SyncGroupDoc; until: number }>();

  constructor(
    private readonly dbProvider: () => Db,
    private readonly now: () => number = Date.now,
  ) {}

  private col(): Collection<SyncGroupDoc> {
    return this.dbProvider().collection<SyncGroupDoc>('biforesting_sync_groups');
  }

  /** The `_id` index is the only one this collection needs. */
  ensureIndexes(): Promise<void> {
    return Promise.resolve();
  }

  /** The stored doc, or the defaults when the group has none. Never writes. */
  async get(group: string): Promise<SyncGroupDoc> {
    const hit = this.cache.get(group);
    if (hit && hit.until > this.now()) return { ...hit.doc };
    const doc = await this.col().findOne({ _id: group });
    const merged: SyncGroupDoc = { ...SYNC_GROUP_DEFAULTS, ...doc, _id: group };
    this.cache.set(group, { doc: merged, until: this.now() + GROUP_CACHE_MS });
    return { ...merged };
  }

  /** Drops one cached group, or all of them. */
  invalidate(group?: string): void {
    if (group === undefined) this.cache.clear();
    else this.cache.delete(group);
  }

  /** Sets the given fields. A first write seeds the defaults for every field not given. */
  async upsert(group: string, fields: SyncGroupFields, updatedBy: string): Promise<SyncGroupDoc> {
    const seed = Object.fromEntries(Object.entries(SYNC_GROUP_DEFAULTS).filter(([k]) => !(k in fields)));
    const doc = await this.col().findOneAndUpdate(
      { _id: group },
      { $set: { ...fields, updatedAt: new Date(), updatedBy }, $setOnInsert: seed },
      { upsert: true, returnDocument: 'after' },
    );
    if (!doc) throw new Error(`sync group ${group}: upsert returned no doc`);
    this.cache.set(group, { doc: { ...SYNC_GROUP_DEFAULTS, ...doc }, until: this.now() + GROUP_CACHE_MS });
    return doc;
  }
}
