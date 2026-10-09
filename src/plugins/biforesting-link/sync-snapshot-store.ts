import { Binary, type Collection, type Db } from 'mongodb';
import { logger } from '../../core/logger/index.js';
import type { SyncLedgerStore } from './sync-ledger-store.js';
import type { SyncSnapHeader, SyncSnapKind } from './types.js';

/**
 * Player sync snapshots in `biforesting_sync_snapshots` (bifrost-lib
 * `docs/invariants/player-sync.md` section 5): one doc per accepted `biforesting:syncsnap`, with
 * the header and the opaque gz blob. Node never parses the blob.
 *
 * Retention per (group, uuid) and kind, trimmed after each new insert:
 * - `shadow`: newest 5, 30-day `expireAt`.
 * - `release`: newest 10, never one whose `v` equals the ledger version, no expiry.
 * - `pre_sync`: newest 10, 180-day `expireAt`.
 */

const DAY_MS = 24 * 3600_000;

export const SNAPSHOT_RETENTION: Record<SyncSnapKind, { keep: number; ttlMs: number | null }> = {
  shadow: { keep: 5, ttlMs: 30 * DAY_MS },
  release: { keep: 10, ttlMs: null },
  pre_sync: { keep: 10, ttlMs: 180 * DAY_MS },
};

export interface SyncSnapshotDoc {
  /** See {@link syncSnapshotId}. */
  _id: string;
  group: string;
  uuid: string;
  name: string;
  v: number;
  kind: SyncSnapKind;
  /** The sending instance (Pterodactyl serverId). */
  serverId: string;
  moveId: string | null;
  fp: string | null;
  dv: number | null;
  sha256: string;
  gzLen: number;
  rawLen: number | null;
  header: SyncSnapHeader;
  gz: Binary;
  createdAt: Date;
  expireAt?: Date;
}

/** A snapshot doc without its blob. */
export type SyncSnapshotMeta = Omit<SyncSnapshotDoc, 'gz'>;

export interface SyncSnapshotInput {
  group: string;
  serverId: string;
  header: SyncSnapHeader;
  gz: Buffer;
}

/**
 * The snapshot key, `<group>:<uuid>:<v>:<kind>:<serverId>` plus a tail.
 * - `shadow`: `:<at>` (the header time, else the insert time). A shadow snapshot carries no move
 *   and its `v` stays 0 until the first move. Without `at` the ring would never fill.
 * - `release` and `pre_sync`: `:<moveId>:<first 12 hex of sha256>`. A retried release can build
 *   another blob, and a later move can reach the same `v` after an abort. Each gets its own doc.
 */
export function syncSnapshotId(
  group: string,
  uuid: string,
  v: number,
  kind: SyncSnapKind,
  serverId: string,
  tail: { at?: number; moveId?: string | null; sha256?: string | null } = {},
): string {
  const base = `${group}:${uuid.toLowerCase()}:${v}:${kind}:${serverId}`;
  if (kind === 'shadow') return `${base}:${tail.at ?? 0}`;
  return `${base}:${tail.moveId ?? ''}:${(tail.sha256 ?? '').toLowerCase().slice(0, 12)}`;
}

const NO_BLOB = { projection: { gz: 0 } } as const;
const NEWEST_FIRST = { createdAt: -1, v: -1, _id: -1 } as const;

export class SyncSnapshotStore {
  private indexEnsured = false;

  constructor(
    private readonly dbProvider: () => Db,
    private readonly ledger: Pick<SyncLedgerStore, 'get'>,
  ) {}

  private col(): Collection<SyncSnapshotDoc> {
    return this.dbProvider().collection<SyncSnapshotDoc>('biforesting_sync_snapshots');
  }

  async ensureIndexes(): Promise<void> {
    if (this.indexEnsured) return;
    const col = this.col();
    await col.createIndex({ group: 1, uuid: 1, kind: 1, createdAt: -1 });
    await col.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
    this.indexEnsured = true;
  }

  /**
   * Stores one snapshot. A replay of the same `_id` keeps the first doc and returns it with
   * `duplicate: true`. A new insert trims the (group, uuid, kind) ring.
   */
  async insert(input: SyncSnapshotInput): Promise<{ snapshot: SyncSnapshotMeta; duplicate: boolean }> {
    await this.ensureIndexes();
    const { group, serverId, header, gz } = input;
    const now = new Date();
    const ttlMs = SNAPSHOT_RETENTION[header.kind].ttlMs;
    const meta: SyncSnapshotMeta = {
      _id: syncSnapshotId(group, header.uuid, header.v, header.kind, serverId, { at: header.at ?? now.getTime(), moveId: header.moveId ?? null, sha256: header.sha256 }),
      group,
      uuid: header.uuid.toLowerCase(),
      name: header.name,
      v: header.v,
      kind: header.kind,
      serverId,
      moveId: header.moveId ?? null,
      fp: header.fp ?? null,
      dv: header.dv ?? null,
      sha256: header.sha256,
      gzLen: gz.length,
      rawLen: header.rawLen ?? null,
      header,
      createdAt: now,
      ...(ttlMs !== null ? { expireAt: new Date(now.getTime() + ttlMs) } : {}),
    };
    try {
      await this.col().insertOne({ ...meta, gz: new Binary(gz) });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      const first = await this.col().findOne({ _id: meta._id }, NO_BLOB);
      if (!first) throw err;
      return { snapshot: first, duplicate: true };
    }
    try {
      await this.trim(meta.group, meta.uuid, meta.kind);
    } catch (err) {
      logger.warn({ err, snapshotId: meta._id }, 'biforesting-sync: snapshot ring trim failed');
    }
    return { snapshot: meta, duplicate: false };
  }

  /** Newest-first snapshots of a player, without blobs. */
  async list(group: string, uuid: string, kind?: SyncSnapKind): Promise<SyncSnapshotMeta[]> {
    await this.ensureIndexes();
    return this.col()
      .find({ group, uuid: uuid.toLowerCase(), ...(kind ? { kind } : {}) }, NO_BLOB)
      .sort(NEWEST_FIRST)
      .toArray();
  }

  /** The newest snapshot of one kind, without its blob. */
  async newest(group: string, uuid: string, kind: SyncSnapKind): Promise<SyncSnapshotMeta | null> {
    await this.ensureIndexes();
    return this.col().find({ group, uuid: uuid.toLowerCase(), kind }, NO_BLOB).sort(NEWEST_FIRST).limit(1).next();
  }

  /** One snapshot with its blob. */
  async get(id: string): Promise<SyncSnapshotDoc | null> {
    await this.ensureIndexes();
    return this.col().findOne({ _id: id });
  }

  /** One snapshot without its blob. */
  async getMeta(id: string): Promise<SyncSnapshotMeta | null> {
    await this.ensureIndexes();
    return this.col().findOne({ _id: id }, NO_BLOB);
  }

  private async trim(group: string, uuid: string, kind: SyncSnapKind): Promise<void> {
    const excess = await this.col()
      .find({ group, uuid, kind }, { projection: { _id: 1, v: 1 } })
      .sort(NEWEST_FIRST)
      .skip(SNAPSHOT_RETENTION[kind].keep)
      .toArray();
    if (excess.length === 0) return;
    const keepV = kind === 'release' ? ((await this.ledger.get(group, uuid))?.version ?? null) : null;
    const ids = excess.filter((d) => d.v !== keepV).map((d) => d._id);
    if (ids.length > 0) await this.col().deleteMany({ _id: { $in: ids } });
  }
}
