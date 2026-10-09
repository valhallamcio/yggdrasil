import type { Collection, Db, ObjectId } from 'mongodb';
import type { SyncBlockedEntry } from './types.js';

/**
 * Shadow-move verdicts in `biforesting_sync_shadow` (bifrost-lib
 * `docs/invariants/player-sync.md` sections 5 and 6.5). S1 stores one doc per
 * `POST .../shadow-move` so staff can judge how many real moves would pass. 30-day TTL.
 */

export const SHADOW_TTL_MS = 30 * 24 * 3600_000;

/** Stable reason codes of a blocked shadow verdict. */
export type ShadowReasonCode =
  | 'not_member'
  | 'no_link'
  | 'feature_off'
  | 'fingerprint_mismatch'
  | 'frozen'
  | 'blocked_items'
  | 'no_snapshot';

export interface ShadowReason {
  code: ShadowReasonCode;
  /** The instance the reason is about, when it is about one. */
  serverId?: string;
  detail?: string;
  /** `blocked_items`: the snapshot the list comes from. */
  snapshotId?: string;
  blocked?: SyncBlockedEntry[];
}

export interface SyncShadowDoc {
  _id?: ObjectId;
  group: string;
  uuid: string;
  from: string;
  to: string;
  at: Date;
  verdict: 'ok' | 'blocked';
  reasons: ShadowReason[];
  expireAt: Date;
}

export class SyncShadowStore {
  private indexEnsured = false;

  constructor(private readonly dbProvider: () => Db) {}

  private col(): Collection<SyncShadowDoc> {
    return this.dbProvider().collection<SyncShadowDoc>('biforesting_sync_shadow');
  }

  async ensureIndexes(): Promise<void> {
    if (this.indexEnsured) return;
    await this.col().createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
    this.indexEnsured = true;
  }

  async insert(verdict: Omit<SyncShadowDoc, '_id' | 'expireAt'>): Promise<SyncShadowDoc> {
    await this.ensureIndexes();
    const doc: SyncShadowDoc = { ...verdict, expireAt: new Date(verdict.at.getTime() + SHADOW_TTL_MS) };
    await this.col().insertOne(doc);
    return doc;
  }
}
