import type { Collection, Db, Filter, UpdateFilter } from 'mongodb';
import type { SyncMode } from './sync-groups-store.js';
import type { SyncStamp } from './types.js';

/**
 * The player sync ledger in `biforesting_sync_players` (bifrost-lib
 * `docs/invariants/player-sync.md` section 5): one doc per (group, player) with the owner
 * instance, the version and the move state. Owners are Pterodactyl serverIds, never instanceKeys.
 *
 * S1 (shadow) writes only through {@link SyncLedgerStore.upsertFromPresence}, which never changes
 * the owner of an existing doc. S2 moves owners through {@link SyncLedgerStore.casUpdate}.
 */

export const SYNC_PLAYER_STATES = ['online', 'moving', 'applying', 'stuck'] as const;
export type SyncPlayerState = (typeof SYNC_PLAYER_STATES)[number];

export type PresenceEvent = 'join' | 'quit' | 'snapshot';

export interface SyncMoveRef {
  id: string;
  from: string;
  to: string;
  step: string;
  startedAt: Date;
  updatedAt: Date;
}

export interface SyncLease {
  holder: string;
  until: Date;
}

export interface SyncLastSeen {
  serverId: string;
  event: PresenceEvent;
  at: Date;
  stamp: SyncStamp | null;
}

export interface SyncPlayerDoc {
  /** `<group>:<uuid>`, uuid lowercase. */
  _id: string;
  group: string;
  uuid: string;
  name: string;
  owner: string | null;
  version: number;
  state: SyncPlayerState;
  move: SyncMoveRef | null;
  lease: SyncLease | null;
  lastSeen: SyncLastSeen | null;
  /** True when the doc was created in shadow mode. */
  shadow: boolean;
  /** Members that completed `sync_disown` for this doc (S2, live mode). */
  disowned: string[];
  /**
   * Set by a reseed of the owner after a restore (spec 6.7). The owner's next join or snapshot
   * entry sets the version from its stamp, clears this flag and kicks nobody. Absent otherwise.
   */
  trustDisk?: boolean;
  /**
   * Set by a reseed with the restored owner's serverId (spec 6.7): a `sync_own` to that owner is
   * still due, so a restored `away` or `moving` mark there does not lock the owner out. A completed
   * `sync_own` there, or the owner's next join or snapshot entry, clears it. Absent otherwise.
   */
  ownPending?: string;
  updatedAt: Date;
  createdAt: Date;
}

/** The guard of one ledger write. Every given part must match, or the write is lost. */
export interface SyncCasFilter {
  _id: string;
  state?: SyncPlayerState | SyncPlayerState[];
  /** The open move id. Null matches a doc with no move. */
  moveId?: string | null;
  /** Passes when the lease is free, held by `holder`, or lapsed at `now`. */
  lease?: { holder: string; now: Date };
  /** The owner serverId. Null matches a doc with no owner. */
  owner?: string | null;
  version?: number;
}

export function ledgerId(group: string, uuid: string): string {
  return `${group}:${uuid.toLowerCase()}`;
}

/**
 * Lease holder prefix of a quest lock (phase6 DESIGN 4 and 7). A quest action or a party merge
 * holds the lease of an `online` doc while its ops run, so no move starts in that time.
 */
export const QUEST_LOCK_PREFIX = 'quests:';

/** True when a quest action or a party merge holds the doc at `now`. */
export function questLockHeld(doc: Pick<SyncPlayerDoc, 'lease'>, now: number): boolean {
  return !!doc.lease && doc.lease.holder.startsWith(QUEST_LOCK_PREFIX) && doc.lease.until.getTime() > now;
}

/** A presence stamp with the spec 3.3 shape, or null. */
export function toSyncStamp(raw: unknown): SyncStamp | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { g, v, m } = raw as Record<string, unknown>;
  if (typeof g !== 'string' || typeof v !== 'number' || !Number.isSafeInteger(v)) return null;
  return typeof m === 'string' ? { g, v, m } : { g, v };
}

export class SyncLedgerStore {
  private indexEnsured = false;

  constructor(
    private readonly dbProvider: () => Db,
    private readonly now: () => number = Date.now,
  ) {}

  private col(): Collection<SyncPlayerDoc> {
    return this.dbProvider().collection<SyncPlayerDoc>('biforesting_sync_players');
  }

  async ensureIndexes(): Promise<void> {
    if (this.indexEnsured) return;
    const col = this.col();
    await col.createIndex({ group: 1, state: 1 });
    await col.createIndex({ state: 1, 'lease.until': 1 });
    await col.createIndex({ 'move.id': 1 }, { sparse: true });
    this.indexEnsured = true;
  }

  async get(group: string, uuid: string): Promise<SyncPlayerDoc | null> {
    return this.col().findOne({ _id: ledgerId(group, uuid) });
  }

  /**
   * Presence path (spec 6.5). Every event sets `lastSeen` on an existing doc. A join or a snapshot
   * entry with no doc creates one owned by `serverId` at `max(stamp.v, 0)`. A quit never creates
   * a doc. The owner, version and state of an existing doc never change here.
   */
  async upsertFromPresence(
    group: string,
    uuid: string,
    name: string,
    serverId: string,
    event: PresenceEvent,
    stamp: SyncStamp | null,
    mode: Exclude<SyncMode, 'off'>,
  ): Promise<SyncPlayerDoc | null> {
    const _id = ledgerId(group, uuid);
    const now = new Date(this.now());
    const lastSeen: SyncLastSeen = { serverId, event, at: now, stamp };
    const set = { name, lastSeen, updatedAt: now };
    if (event === 'quit') {
      return this.col().findOneAndUpdate({ _id }, { $set: set }, { returnDocument: 'after' });
    }
    const update: UpdateFilter<SyncPlayerDoc> = {
      $set: set,
      $setOnInsert: {
        group,
        uuid: uuid.toLowerCase(),
        owner: serverId,
        version: Math.max(stamp?.v ?? 0, 0),
        state: 'online',
        move: null,
        lease: null,
        shadow: mode === 'shadow',
        disowned: [],
        createdAt: now,
      },
    };
    try {
      return await this.col().findOneAndUpdate({ _id }, update, { upsert: true, returnDocument: 'after' });
    } catch (err) {
      // Two instances raced to create the doc. The loser's retry finds it and only sets lastSeen.
      if ((err as { code?: number }).code !== 11000) throw err;
      return this.col().findOneAndUpdate({ _id }, update, { upsert: true, returnDocument: 'after' });
    }
  }

  /**
   * One guarded ledger write (S2 runner, trade-settlement pattern). Returns the doc after the
   * write, or null when the guard did not match. `updatedAt` is always set.
   */
  async casUpdate(filter: SyncCasFilter, update: UpdateFilter<SyncPlayerDoc>): Promise<SyncPlayerDoc | null> {
    const q: Record<string, unknown> = { _id: filter._id };
    if (filter.state !== undefined) q['state'] = Array.isArray(filter.state) ? { $in: filter.state } : filter.state;
    if (filter.moveId !== undefined) q['move.id'] = filter.moveId;
    if (filter.owner !== undefined) q['owner'] = filter.owner;
    if (filter.version !== undefined) q['version'] = filter.version;
    if (filter.lease) {
      q['$or'] = [{ lease: null }, { 'lease.holder': filter.lease.holder }, { 'lease.until': { $lt: filter.lease.now } }];
    }
    const withStamp: UpdateFilter<SyncPlayerDoc> = { ...update, $set: { ...update.$set, updatedAt: new Date(this.now()) } };
    return this.col().findOneAndUpdate(q as Filter<SyncPlayerDoc>, withStamp, { returnDocument: 'after' });
  }

  /**
   * Takes the quest lock: the lease of an `online` doc with no move, owned by `owner`, whose lease
   * is free or lapsed at `now`. Null when the guard did not match. Move starts and force-releases
   * CAS on a free lease, so they fail while the lock holds.
   */
  async takeQuestLock(group: string, uuid: string, owner: string, holder: string, now: Date, until: Date): Promise<SyncPlayerDoc | null> {
    return this.col().findOneAndUpdate(
      { _id: ledgerId(group, uuid), state: 'online', move: null, owner, $or: [{ lease: null }, { 'lease.until': { $lt: now } }] },
      { $set: { lease: { holder, until }, updatedAt: new Date(this.now()) } },
      { returnDocument: 'after' },
    );
  }

  /** Frees a lease that `holder` still holds. False when another holder took it, or none holds it. */
  async releaseLease(group: string, uuid: string, holder: string): Promise<boolean> {
    const res = await this.col().updateOne(
      { _id: ledgerId(group, uuid), 'lease.holder': holder },
      { $set: { lease: null, updatedAt: new Date(this.now()) } },
    );
    return res.modifiedCount > 0;
  }

  /** Docs with an open move whose lease is free or lapsed at `now` (the runner sweep). */
  async listLapsed(now: Date, limit = 500): Promise<SyncPlayerDoc[]> {
    return this.col()
      .find({ state: { $in: ['moving', 'applying'] }, $or: [{ lease: null }, { 'lease.until': { $lt: now } }] })
      .limit(limit)
      .toArray();
  }

  /** Extends every live lease of `holder` on a doc with an open move. Returns the count. */
  async renewLeases(holder: string, until: Date): Promise<number> {
    const res = await this.col().updateMany(
      { 'lease.holder': holder, state: { $in: ['moving', 'applying'] } },
      { $set: { 'lease.until': until } },
    );
    return res.modifiedCount;
  }

  /**
   * Docs of a group owned by one of `owners` whose `disowned` list lacks `member` (spec 6.6), by
   * `_id`. Pass the last `_id` of a page as `afterId` for the next page.
   */
  async listNeedingDisown(group: string, member: string, owners: string[], limit: number, afterId?: string): Promise<SyncPlayerDoc[]> {
    const q: Filter<SyncPlayerDoc> = { group, owner: { $in: owners }, disowned: { $ne: member } };
    if (afterId !== undefined) q._id = { $gt: afterId };
    return this.col().find(q).sort({ _id: 1 }).limit(limit).toArray();
  }

  /** Records that `serverId` completed a `sync_disown` for these players. */
  async markDisowned(group: string, uuids: string[], serverId: string): Promise<number> {
    if (uuids.length === 0) return 0;
    const res = await this.col().updateMany(
      { _id: { $in: uuids.map((u) => ledgerId(group, u)) } },
      { $addToSet: { disowned: serverId } },
    );
    return res.modifiedCount;
  }

  /** The number of docs of a group owned by one of `owners` whose `disowned` list lacks `member`. */
  async countNeedingDisown(group: string, member: string, owners: string[]): Promise<number> {
    return this.col().countDocuments({ group, owner: { $in: owners }, disowned: { $ne: member } });
  }

  /**
   * Reseed (spec 6.7): `member` leaves the `disowned` list of every doc of the group that it does
   * not own. A restore dropped the `away` marks of its disowns, so they must run again.
   */
  async resetDisowned(group: string, member: string): Promise<number> {
    const res = await this.col().updateMany(
      { group, owner: { $ne: member }, disowned: member },
      { $pull: { disowned: member }, $set: { updatedAt: new Date(this.now()) } },
    );
    return res.modifiedCount;
  }

  /**
   * Reseed (spec 6.7): sets `trustDisk` and `ownPending: owner` on every online doc that `owner`
   * owns. Returns the count.
   */
  async setTrustDisk(group: string, owner: string): Promise<number> {
    const res = await this.col().updateMany(
      { group, owner, state: 'online' },
      { $set: { trustDisk: true, ownPending: owner, updatedAt: new Date(this.now()) } },
    );
    return res.matchedCount;
  }

  /**
   * Online docs of a group that `owner` owns and whose `ownPending` names it (spec 6.7), by
   * `_id`. Pass the last `_id` of a page as `afterId` for the next page.
   */
  async listNeedingOwn(group: string, owner: string, limit: number, afterId?: string): Promise<SyncPlayerDoc[]> {
    const q: Filter<SyncPlayerDoc> = { group, owner, state: 'online', ownPending: owner };
    if (afterId !== undefined) q._id = { $gt: afterId };
    return this.col().find(q).sort({ _id: 1 }).limit(limit).toArray();
  }

  /** Records that `serverId` completed a `sync_own` for these players. */
  async clearOwnPending(group: string, uuids: string[], serverId: string): Promise<number> {
    if (uuids.length === 0) return 0;
    const res = await this.col().updateMany(
      { _id: { $in: uuids.map((u) => ledgerId(group, u)) }, ownPending: serverId },
      { $unset: { ownPending: '' } },
    );
    return res.modifiedCount;
  }

  /**
   * The detector side of a reseed (spec 6.4): the owner reported its stamp, so the version takes
   * it, and `trustDisk` and `ownPending` go: the login passed there. Null when the doc is no
   * longer online on `owner` with `trustDisk`.
   */
  async acceptDiskStamp(group: string, uuid: string, owner: string, version: number): Promise<SyncPlayerDoc | null> {
    return this.col().findOneAndUpdate(
      { _id: ledgerId(group, uuid), owner, state: 'online', move: null, trustDisk: true },
      { $set: { version, updatedAt: new Date(this.now()) }, $unset: { trustDisk: '', ownPending: '' } },
      { returnDocument: 'after' },
    );
  }

  /** Ledger docs of a group by state. */
  async countByState(group: string): Promise<Record<SyncPlayerState, number>> {
    const counts: Record<SyncPlayerState, number> = { online: 0, moving: 0, applying: 0, stuck: 0 };
    const rows = await this.col()
      .aggregate<{ _id: string; n: number }>([{ $match: { group } }, { $group: { _id: '$state', n: { $sum: 1 } } }])
      .toArray();
    for (const row of rows) {
      if ((SYNC_PLAYER_STATES as readonly string[]).includes(row._id)) counts[row._id as SyncPlayerState] = row.n;
    }
    return counts;
  }
}
