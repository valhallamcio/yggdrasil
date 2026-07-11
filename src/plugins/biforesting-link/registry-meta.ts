import type { Collection, Db } from 'mongodb';

/**
 * Active-generation pointer for the dump-authoritative registries (items + quests).
 *
 * A dump used to be persisted as deleteMany → insertMany, which is not atomic: a mid-insert
 * failure (mongo blip, malformed dump) or two interleaved dumps from a reconnecting server left
 * the registry empty/partial with only a warn in the log. Instead, every dump now inserts its
 * rows tagged with a fresh `dumpId` FIRST, then flips this meta doc, then sweeps older
 * generations — readers filter by the active dumpId, so they see the old complete generation
 * until the very moment the new one is fully written.
 *
 * Lives in its own collection (NOT the registry collections) on purpose: the generation sweep is
 * `deleteMany({instanceKey, dumpId: {$ne: active}})`, which would match any meta doc stored
 * alongside the rows (and, usefully, DOES match legacy pre-generation rows that have no dumpId).
 */

export interface RegistryGeneration {
  activeDumpId: string;
  source: string;
  count: number;
  dumpedAt: Date;
}

interface RegistryMetaDoc extends RegistryGeneration {
  _id: string;
}

export type RegistryKind = 'item' | 'quest';

function metaCol(db: Db): Collection<RegistryMetaDoc> {
  return db.collection<RegistryMetaDoc>('biforesting_registry_meta');
}

function metaId(kind: RegistryKind, instanceKey: string): string {
  return `${kind}:${instanceKey}`;
}

/** Flip the active generation for an instance's registry. Only called after a full insert. */
export async function setActiveGeneration(
  db: Db,
  kind: RegistryKind,
  instanceKey: string,
  gen: RegistryGeneration,
): Promise<void> {
  await metaCol(db).updateOne({ _id: metaId(kind, instanceKey) }, { $set: gen }, { upsert: true });
}

export async function getActiveGeneration(db: Db, kind: RegistryKind, instanceKey: string): Promise<RegistryGeneration | null> {
  const doc = await metaCol(db).findOne({ _id: metaId(kind, instanceKey) });
  if (!doc) return null;
  return { activeDumpId: doc.activeDumpId, source: doc.source, count: doc.count, dumpedAt: doc.dumpedAt };
}

/**
 * Per-key async mutex (promise chaining). Node is single-threaded but `await`s interleave — two
 * dumps for the same instance (fast reconnect) must not interleave their insert/flip/sweep steps,
 * and without the lock a SLOW old dump could flip the meta doc over a newer one after the fact.
 */
const chains = new Map<string, Promise<void>>();

/**
 * True when a bulk-insert error is ONLY duplicate-key collisions (code 11000) — a malformed dump
 * repeating an id. With `ordered:false` every non-colliding row still landed, so the generation
 * is complete minus exact duplicates and the flip may proceed. Any other error means unknown
 * partial state: the caller must discard the generation.
 */
export function isDuplicateKeyOnly(err: unknown): boolean {
  const e = err as { writeErrors?: Array<{ code?: number }>; code?: number };
  if (Array.isArray(e?.writeErrors) && e.writeErrors.length > 0) {
    return e.writeErrors.every((w) => w?.code === 11000);
  }
  return e?.code === 11000;
}

export async function withGenerationLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  chains.set(
    key,
    prev.then(() => gate),
  );
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Drop the chain entry once nothing newer queued behind us, so the map can't grow unbounded.
    if (chains.get(key) === gate) chains.delete(key);
  }
}
