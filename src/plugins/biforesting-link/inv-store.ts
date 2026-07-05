import { Binary, ObjectId, type Collection, type Db } from 'mongodb';
import { getDb } from '../../core/database/client.js';
import { logger } from '../../core/logger/index.js';
import type { InvSnapHeader, LinkIdentity } from './types.js';

/**
 * Inventory snapshot history (plan D12): every accepted `biforesting:invsnap` frame lands in
 * `biforesting_inventories` — display-ready header fields + the opaque full-fidelity NBT gz
 * blob (NEVER parsed or edited in Node; restore tooling lives mod-side). Ring: newest
 * {@link RING_KEEP} per (instanceKey, uuid); TTL 90 d as the backstop.
 */

export const RING_KEEP = 25;
const TTL_SECONDS = 90 * 24 * 3600;

export interface InvSnapshotDoc {
  _id?: ObjectId;
  instanceKey: string;
  tag: string | null;
  serverId: string | null;
  uuid: string;
  name: string;
  reason: string;
  dim: string;
  pos: number[];
  dataVersion: number;
  items: Array<{ slot: number; id: string; count: number }>;
  sizeBytes: number;
  gz: Binary;
  takenAt: Date;
}

let dbProvider: () => Db = getDb;

/** Test seam — mirror of policy-store's. */
export function setInvDbProvider(provider: () => Db): void {
  dbProvider = provider;
  indexesEnsured = false;
}

function col(): Collection<InvSnapshotDoc> {
  return dbProvider().collection<InvSnapshotDoc>('biforesting_inventories');
}

let indexesEnsured = false;

export async function ensureInvIndexes(): Promise<void> {
  if (indexesEnsured) return;
  await col().createIndex({ instanceKey: 1, uuid: 1, takenAt: -1 });
  await col().createIndex({ takenAt: 1 }, { expireAfterSeconds: TTL_SECONDS });
  indexesEnsured = true;
}

/** Insert one snapshot + trim the (instanceKey, uuid) ring to the newest RING_KEEP. */
export async function saveInvSnapshot(identity: LinkIdentity, header: InvSnapHeader, gz: Buffer): Promise<void> {
  try {
    await ensureInvIndexes();
    await col().insertOne({
      instanceKey: identity.instanceKey,
      tag: identity.tag,
      serverId: identity.serverId,
      uuid: header.uuid,
      name: header.name,
      reason: header.reason,
      dim: header.dim,
      pos: header.pos,
      dataVersion: header.dataVersion,
      items: header.items,
      sizeBytes: gz.length,
      gz: new Binary(gz),
      takenAt: new Date(),
    });
    const excess = await col()
      .find({ instanceKey: identity.instanceKey, uuid: header.uuid })
      .sort({ takenAt: -1 })
      .skip(RING_KEEP)
      .project({ _id: 1 })
      .toArray();
    if (excess.length > 0) {
      await col().deleteMany({ _id: { $in: excess.map((d) => d['_id'] as ObjectId) } });
    }
  } catch (err) {
    logger.warn({ err, instanceKey: identity.instanceKey, uuid: header.uuid }, 'biforesting-inv: snapshot insert failed');
  }
}

/** Newest-first headers (no gz blob) for a player on an instance. */
export async function listSnapshots(instanceKey: string, uuid: string, limit = RING_KEEP): Promise<InvSnapshotDoc[]> {
  await ensureInvIndexes();
  return col()
    .find({ instanceKey, uuid }, { projection: { gz: 0 } })
    .sort({ takenAt: -1 })
    .limit(limit)
    .toArray();
}

/** Newest snapshot for a player (headers only) — the offline fallback for the inventory GET. */
export async function latestSnapshot(instanceKey: string, uuidOrName: string): Promise<InvSnapshotDoc | null> {
  await ensureInvIndexes();
  return col()
    .find(
      {
        instanceKey,
        $or: [{ uuid: uuidOrName }, { name: { $regex: `^${escapeRegex(uuidOrName)}$`, $options: 'i' } }],
      },
      { projection: { gz: 0 } },
    )
    .sort({ takenAt: -1 })
    .limit(1)
    .next();
}

/** One snapshot with the gz blob (base64 for transport). */
export async function getSnapshot(id: string): Promise<InvSnapshotDoc | null> {
  await ensureInvIndexes();
  if (!ObjectId.isValid(id)) return null;
  return col().findOne({ _id: new ObjectId(id) });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
