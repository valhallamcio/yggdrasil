import type { Collection, Db, Filter } from 'mongodb';

/**
 * World-data owner locks in `biforesting_sync_worlddata` (bifrost-lib
 * `docs/invariants/player-sync.md` sections 5 and 6, S3). One doc per world-data record that a
 * move carried (a backpack's contents), keyed by group, handler and record key. A record is
 * `owned` by one instance, or `in_transit` between the release and the apply of one move.
 * Owners are Pterodactyl serverIds.
 */

export type WorldDataState = 'owned' | 'in_transit';

export interface SyncWorldDataDoc {
  /** `<group>:<handler>:<key>`. */
  _id: string;
  group: string;
  handler: string;
  key: string;
  /** The owner, or the last owner while in transit. */
  owner: string;
  state: WorldDataState;
  moveId: string | null;
  lastUuid: string | null;
  /**
   * Restored members that still need a `sync_lock` for this record (spec 6.7): a reseed adds the
   * member when another instance owns the record or it is in transit. A completed `sync_lock`
   * there, or the member becoming the owner, takes it out. Absent on most docs.
   */
  lockPending?: string[];
  updatedAt: Date;
}

export function worldDataId(group: string, handler: string, key: string): string {
  return `${group}:${handler}:${key}`;
}

export class SyncWorldDataStore {
  private indexEnsured = false;

  constructor(
    private readonly dbProvider: () => Db,
    private readonly now: () => number = Date.now,
  ) {}

  private col(): Collection<SyncWorldDataDoc> {
    return this.dbProvider().collection<SyncWorldDataDoc>('biforesting_sync_worlddata');
  }

  async ensureIndexes(): Promise<void> {
    if (this.indexEnsured) return;
    await this.col().createIndex({ group: 1, moveId: 1 });
    await this.col().createIndex({ group: 1, owner: 1 });
    await this.col().createIndex({ group: 1, lockPending: 1 }, { sparse: true });
    this.indexEnsured = true;
  }

  async get(group: string, handler: string, key: string): Promise<SyncWorldDataDoc | null> {
    return this.col().findOne({ _id: worldDataId(group, handler, key) });
  }

  /**
   * CAS `owned(from)` or no doc to `in_transit(moveId)`. A doc already in transit for this move
   * passes too, so a re-run is safe. Returns null on success, or the doc that holds the lock.
   */
  async toInTransit(group: string, handler: string, key: string, from: string, moveId: string, uuid: string): Promise<SyncWorldDataDoc | null> {
    await this.ensureIndexes();
    const _id = worldDataId(group, handler, key);
    for (let attempt = 0; attempt < 3; attempt++) {
      const set = { state: 'in_transit' as const, owner: from, moveId, lastUuid: uuid, updatedAt: new Date(this.now()) };
      const moved = await this.col().findOneAndUpdate(
        { _id, $or: [{ state: 'owned', owner: from }, { state: 'in_transit', moveId }] },
        { $set: set },
      );
      if (moved) return null;
      try {
        await this.col().insertOne({ _id, group, handler, key, ...set });
        return null;
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
      }
      const holder = await this.col().findOne({ _id });
      if (holder) return holder;
    }
    throw new Error(`world-data lock ${_id}: no stable state after 3 attempts`);
  }

  /**
   * Every lock `in_transit(moveId)` becomes `owned(owner)`. The new owner needs no `sync_lock`
   * for it any more. Returns the count.
   */
  async settle(group: string, moveId: string, owner: string): Promise<number> {
    const res = await this.col().updateMany(
      { group, state: 'in_transit', moveId },
      { $set: { state: 'owned', owner, moveId: null, updatedAt: new Date(this.now()) }, $pull: { lockPending: owner } },
    );
    return res.modifiedCount;
  }

  /** Staff override (force-release): `owned(owner)` whatever the lock held before. */
  async forceOwned(group: string, handler: string, key: string, owner: string, uuid: string): Promise<void> {
    await this.ensureIndexes();
    await this.col().updateOne(
      { _id: worldDataId(group, handler, key) },
      {
        $set: { group, handler, key, state: 'owned', owner, moveId: null, lastUuid: uuid, updatedAt: new Date(this.now()) },
        $pull: { lockPending: owner },
      },
      { upsert: true },
    );
  }

  /**
   * A reseed of `member` (spec 6.7): every record of the group that another instance owns, or
   * that is in transit, needs a `sync_lock` on `member`. Returns the count of such records.
   */
  async markLockPending(group: string, member: string): Promise<number> {
    await this.ensureIndexes();
    const res = await this.col().updateMany(
      { group, $or: [{ state: 'in_transit' }, { owner: { $ne: member } }] },
      { $addToSet: { lockPending: member } },
    );
    return res.matchedCount;
  }

  /**
   * Records of a group whose `lockPending` names `member`, by `_id`. A record that `member` owns
   * again loses the mark first: it needs no lock there. Pass the last `_id` of a page as
   * `afterId` for the next page.
   */
  async listNeedingLock(group: string, member: string, limit: number, afterId?: string): Promise<SyncWorldDataDoc[]> {
    await this.col().updateMany({ group, lockPending: member, state: 'owned', owner: member }, { $pull: { lockPending: member } });
    const q: Filter<SyncWorldDataDoc> = { group, lockPending: member };
    if (afterId !== undefined) q._id = { $gt: afterId };
    return this.col().find(q).sort({ _id: 1 }).limit(limit).toArray();
  }

  /** Records that `member` completed a `sync_lock` for these records. */
  async clearLockPending(group: string, records: Array<{ h: string; key: string }>, member: string): Promise<number> {
    if (records.length === 0) return 0;
    const res = await this.col().updateMany(
      { _id: { $in: records.map((r) => worldDataId(group, r.h, r.key)) }, lockPending: member },
      { $pull: { lockPending: member } },
    );
    return res.modifiedCount;
  }

  async listByMove(group: string, moveId: string): Promise<SyncWorldDataDoc[]> {
    return this.col().find({ group, moveId }).toArray();
  }
}
