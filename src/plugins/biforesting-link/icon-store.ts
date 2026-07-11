import { createHash } from 'node:crypto';
import { GridFSBucket, type Collection, type Db } from 'mongodb';
import { getDb } from '../../core/database/client.js';
import { logger } from '../../core/logger/index.js';

/**
 * Pack icon store (phase 8). Item icons are dumped client-side (per pack version, once) and
 * uploaded here — an auditable REST path, NOT a shell `mongoimport` on prod. PNG bytes live in
 * a GridFS bucket keyed by their sha256 (so the thousands of identical "missing texture"/tint
 * variants across a pack collapse to one stored blob), and a mapping collection resolves
 * `pack + id → sha`. Icons are for a future web UI; VU's /give-item autocomplete needs only the
 * item search endpoint, not these.
 */

export interface PackIconDoc {
  pack: string;
  id: string; // 'mod:item' or 'mod:item:meta'
  sha: string;
  bytes: number;
  uploadedAt: Date;
}

export interface IconUpload {
  id: string;
  png: Buffer;
}

let dbProvider: () => Db = getDb;

export function setIconDbProvider(provider: () => Db): void {
  dbProvider = provider;
  indexesEnsured = false;
}

function mapCol(): Collection<PackIconDoc> {
  return dbProvider().collection<PackIconDoc>('biforesting_pack_icons');
}

function bucket(): GridFSBucket {
  return new GridFSBucket(dbProvider(), { bucketName: 'biforesting_icons' });
}

let indexesEnsured = false;

async function ensureIndexes(): Promise<void> {
  if (indexesEnsured) return;
  await mapCol().createIndex({ pack: 1, id: 1 }, { unique: true });
  await mapCol().createIndex({ sha: 1 });
  indexesEnsured = true;
}

/** True once a blob with this sha exists in GridFS (dedup guard). */
async function shaExists(sha: string): Promise<boolean> {
  const existing = await bucket().find({ filename: sha }).limit(1).toArray();
  return existing.length > 0;
}

function putBlob(sha: string, png: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stream = bucket().openUploadStream(sha, { metadata: { sha } });
    stream.on('error', reject);
    stream.on('finish', () => resolve());
    stream.end(png);
  });
}

/**
 * GridFS uploads don't unique-key on filename, so two concurrent uploads of the same sha both
 * pass the existence check and both land — keep the oldest file, drop the rest. Idempotent.
 */
async function dedupeBlobs(sha: string): Promise<void> {
  const files = await bucket().find({ filename: sha }).sort({ uploadDate: 1 }).toArray();
  for (const extra of files.slice(1)) {
    try {
      await bucket().delete(extra._id);
    } catch (err) {
      logger.debug({ err, sha }, 'biforesting-icons: duplicate blob delete raced');
    }
  }
}

/** Delete a sha's blob(s) once NO mapping references it anymore (re-mapped icons orphan theirs). */
async function reapOrphanBlob(sha: string): Promise<void> {
  const stillReferenced = await mapCol().countDocuments({ sha }, { limit: 1 });
  if (stillReferenced > 0) return;
  const files = await bucket().find({ filename: sha }).toArray();
  for (const file of files) {
    try {
      await bucket().delete(file._id);
    } catch (err) {
      logger.debug({ err, sha }, 'biforesting-icons: orphan blob delete raced');
    }
  }
}

/**
 * Upload a batch of icons for a pack. Each PNG is stored once by sha (deduped across the whole
 * bucket); the mapping `pack+id → sha` is upserted. Returns per-batch counters.
 */
export async function saveIcons(pack: string, icons: IconUpload[]): Promise<{ stored: number; deduped: number; mapped: number }> {
  await ensureIndexes();
  let stored = 0;
  let deduped = 0;
  let mapped = 0;
  for (const icon of icons) {
    const sha = createHash('sha256').update(icon.png).digest('hex');
    if (await shaExists(sha)) {
      deduped++;
    } else {
      try {
        await putBlob(sha, icon.png);
        stored++;
        // Two concurrent uploads of the same sha both pass shaExists — collapse to one blob.
        await dedupeBlobs(sha);
      } catch (err) {
        logger.debug({ err, sha }, 'biforesting-icons: blob write raced (treating as deduped)');
        deduped++;
      }
    }
    const prev = await mapCol().findOneAndUpdate(
      { pack, id: icon.id },
      { $set: { pack, id: icon.id, sha, bytes: icon.png.length, uploadedAt: new Date() } },
      { upsert: true },
    );
    mapped++;
    // A re-upload that changed this icon's pixels leaves the old blob behind — reap it if this
    // was its last reference.
    if (prev && prev.sha !== sha) {
      await reapOrphanBlob(prev.sha);
    }
  }
  return { stored, deduped, mapped };
}

/** Resolve a pack+id to its PNG bytes (null if unmapped or the blob is gone). */
export async function getIcon(pack: string, id: string): Promise<Buffer | null> {
  await ensureIndexes();
  const doc = await mapCol().findOne({ pack, id });
  if (!doc) return null;
  const files = await bucket().find({ filename: doc.sha }).limit(1).toArray();
  if (files.length === 0) return null;
  return new Promise<Buffer | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = bucket().openDownloadStreamByName(doc.sha);
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** Icon coverage for a pack: how many ids are mapped, and how many distinct blobs back them. */
export async function iconInfo(pack: string): Promise<{ mapped: number; blobs: number }> {
  await ensureIndexes();
  const mapped = await mapCol().countDocuments({ pack });
  const shas = await mapCol().distinct('sha', { pack });
  return { mapped, blobs: shas.length };
}
