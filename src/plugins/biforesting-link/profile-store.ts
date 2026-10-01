import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GridFSBucket, ObjectId, type Collection, type Db, type GridFSBucketWriteStream, type GridFSFile } from 'mongodb';
import { config } from '../../config/index.js';
import { getDb } from '../../core/database/client.js';
import { logger } from '../../core/logger/index.js';
import {
  ArtifactVerifier,
  MAX_ARTIFACT_BYTES,
  MAX_REPORT_BYTES,
  ProfileUploadError,
  parseProfileReport,
  summarizeProfileReport,
  type ProfileArtifact,
  type ProfileKind,
  type ProfileReportSummary,
} from './profile-upload.js';

/**
 * Profiler capture storage (profiler plan phase 4). Artifacts live in GridFS bucket
 * `biforesting_profiles`, like the icon store. A parsed summary of each report.json goes to
 * `biforesting_profile_reports`, so fleet queries never read blobs. Upload grants live in
 * `biforesting_profile_uploads`.
 *
 * Report docs carry `kind`: `capture` for op and command captures, `spike` for spike catcher dumps.
 * A spike doc arrives on the `biforesting:spike` link channel before any file exists. Its files
 * come later through a `profile_fetch` op. Docs written before kinds existed have no `kind` and
 * count as captures.
 *
 * Retention is an hourly sweep ({@link startProfileCleanup}). A TTL index on the files
 * collection would leave the chunks behind, so the sweep deletes through the bucket.
 */

export const PROFILE_RETENTION_MS = 30 * 24 * 3600_000;
/** An upload token stays valid this long after the op's result deadline. */
export const UPLOAD_GRACE_MS = 30 * 60_000;
const CLEANUP_INTERVAL_MS = 3600_000;
/** Chunks without a file doc that are older than this come from a crashed or aborted upload. */
const ORPHAN_GRACE_MS = 3600_000;
const BUCKET = 'biforesting_profiles';

export interface ProfileUploadGrantDoc {
  token: string;
  opId: string;
  instanceKey: string;
  /** Link serverId the upload URL was built with. */
  serverId: string;
  /** Bound on the first upload. Later uploads with this token must use the same capture. */
  captureId: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface ProfileFileMeta {
  serverId: string;
  instanceKey: string;
  captureId: string;
  artifact: ProfileArtifact;
  sha256: string;
  size: number | null;
  opId: string | null;
}

export interface ProfileReportDoc extends ProfileReportSummary {
  serverId: string;
  instanceKey: string;
  captureId: string;
  opId: string | null;
  createdAt: Date;
}

export interface StoredArtifact {
  artifact: ProfileArtifact;
  size: number;
  sha256: string;
  uploadedAt: Date;
}

export interface CaptureListEntry {
  captureId: string;
  kind: ProfileKind;
  /** The spike dump's trigger block. Null for a capture. */
  trigger: Record<string, unknown> | null;
  opId: string | null;
  serverId: string | null;
  createdAt: Date;
  hasReport: boolean;
  artifacts: string[];
  bytes: number;
  level?: string | null;
  sampler?: string | null;
  startedAt?: Date | null;
  durationMs?: number;
  tickCount?: number;
  mspt?: ProfileReportSummary['mspt'];
  tps?: number;
  truncated?: boolean;
  hotspotsTotal?: number;
}

export interface FleetHotspot extends Record<string, unknown> {
  server: string;
  serverId: string;
  captureId: string;
  createdAt: Date;
}

let dbProvider: () => Db = getDb;

/** Test seam, like the other stores. */
export function setProfileDbProvider(provider: () => Db): void {
  dbProvider = provider;
  indexesEnsured = false;
}

function bucket(): GridFSBucket {
  return new GridFSBucket(dbProvider(), { bucketName: BUCKET });
}

function filesCol(): Collection<GridFSFile> {
  return dbProvider().collection<GridFSFile>(`${BUCKET}.files`);
}

function chunksCol(): Collection<{ files_id: ObjectId }> {
  return dbProvider().collection<{ files_id: ObjectId }>(`${BUCKET}.chunks`);
}

function reportsCol(): Collection<ProfileReportDoc> {
  return dbProvider().collection<ProfileReportDoc>('biforesting_profile_reports');
}

function grantsCol(): Collection<ProfileUploadGrantDoc> {
  return dbProvider().collection<ProfileUploadGrantDoc>('biforesting_profile_uploads');
}

let indexesEnsured = false;

export async function ensureProfileIndexes(): Promise<void> {
  if (indexesEnsured) return;
  await filesCol().createIndex({ 'metadata.instanceKey': 1, 'metadata.captureId': 1, 'metadata.artifact': 1 });
  await filesCol().createIndex({ uploadDate: 1 });
  await reportsCol().createIndex({ instanceKey: 1, captureId: 1 }, { unique: true });
  await reportsCol().createIndex({ instanceKey: 1, createdAt: -1 });
  await reportsCol().createIndex({ createdAt: 1 });
  await grantsCol().createIndex({ token: 1 }, { unique: true });
  await grantsCol().createIndex({ opId: 1 }, { unique: true });
  // Grants are small docs in a plain collection, so a TTL index is safe here.
  await grantsCol().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  indexesEnsured = true;
}

/** `<BIFORESTING_PUBLIC_URL>/v1/biforesting/<serverId>/profiles/`. The mod appends `<captureId>/<artifact>`. */
export function profileUploadUrl(serverId: string): string {
  const base = config.BIFORESTING_PUBLIC_URL.replace(/\/+$/, '');
  return `${base}/v1/biforesting/${encodeURIComponent(serverId)}/profiles/`;
}

// ── Upload grants ────────────────────────────────────────────────────────────

/**
 * One token per op. A re-dispatch gets the same token back and a later expiry. The mod's opId
 * journal replays the first dispatch, so it only ever knows the first token. A `captureId` binds
 * the token to that capture from the start (`profile_fetch`).
 */
export async function issueUploadGrant(input: {
  opId: string;
  instanceKey: string;
  serverId: string;
  expiresAt: Date;
  captureId?: string;
}): Promise<ProfileUploadGrantDoc> {
  await ensureProfileIndexes();
  const upsert = (): Promise<ProfileUploadGrantDoc | null> =>
    grantsCol().findOneAndUpdate(
      { opId: input.opId },
      {
        $setOnInsert: {
          token: randomBytes(32).toString('base64url'),
          opId: input.opId,
          instanceKey: input.instanceKey,
          serverId: input.serverId,
          captureId: input.captureId ?? null,
          createdAt: new Date(),
        },
        $max: { expiresAt: input.expiresAt },
      },
      { upsert: true, returnDocument: 'after' },
    );
  let doc: ProfileUploadGrantDoc | null;
  try {
    doc = await upsert();
  } catch (err) {
    // Two concurrent upserts of one opId: the loser hits the unique index. The retry matches.
    if ((err as { code?: number }).code !== 11000) throw err;
    doc = await upsert();
  }
  if (!doc) throw new Error('upload grant upsert returned nothing');
  return doc;
}

export async function findUploadGrant(token: string): Promise<ProfileUploadGrantDoc | null> {
  await ensureProfileIndexes();
  return grantsCol().findOne({ token });
}

/** Binds the grant to a capture on first use. False when it is bound to another capture. */
export async function bindGrantCapture(token: string, captureId: string): Promise<boolean> {
  const res = await grantsCol().updateOne(
    { token, $or: [{ captureId: null }, { captureId }] },
    { $set: { captureId } },
  );
  return res.matchedCount === 1;
}

// ── Artifacts ────────────────────────────────────────────────────────────────

function artifactFilter(instanceKey: string, captureId: string, artifact?: string): Record<string, unknown> {
  return {
    'metadata.instanceKey': instanceKey,
    'metadata.captureId': captureId,
    ...(artifact ? { 'metadata.artifact': artifact } : {}),
  };
}

export async function artifactExists(instanceKey: string, captureId: string, artifact: string): Promise<boolean> {
  return (await filesCol().countDocuments(artifactFilter(instanceKey, captureId, artifact), { limit: 1 })) > 0;
}

/**
 * Streams one artifact into GridFS. The hash, the size cap and the report.json parse all run
 * before the file doc is written, so a rejected body leaves only chunks, and those are removed.
 * report.json also upserts the summary doc.
 */
export async function storeArtifact(input: {
  source: Readable;
  serverId: string;
  instanceKey: string;
  captureId: string;
  artifact: ProfileArtifact;
  sha256: string;
  opId: string | null;
  maxBytes?: number;
}): Promise<{ size: number; report: boolean }> {
  await ensureProfileIndexes();
  const { instanceKey, captureId, artifact } = input;
  if (await artifactExists(instanceKey, captureId, artifact)) {
    throw new ProfileUploadError(409, `${artifact} is already stored for capture ${captureId}`);
  }

  const parsed: { summary: ProfileReportSummary | null } = { summary: null };
  const isReport = artifact === 'report.json';
  const limit = Math.min(input.maxBytes ?? MAX_ARTIFACT_BYTES, isReport ? MAX_REPORT_BYTES : MAX_ARTIFACT_BYTES);
  const verifier = new ArtifactVerifier(
    input.sha256,
    limit,
    isReport
      ? (body: Buffer): void => {
          parsed.summary = parseProfileReport(body, captureId);
        }
      : undefined,
  );
  const meta: ProfileFileMeta = {
    serverId: input.serverId,
    instanceKey,
    captureId,
    artifact,
    sha256: input.sha256,
    size: null,
    opId: input.opId,
  };
  const upload = bucket().openUploadStream(`${instanceKey}/${captureId}/${artifact}`, { metadata: meta });

  try {
    await pipeline(input.source, verifier, upload);
  } catch (err) {
    await discardUpload(upload);
    if (err instanceof ProfileUploadError) throw err;
    const code = (err as { code?: string }).code;
    if (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET') {
      throw new ProfileUploadError(400, 'upload aborted before the body was complete');
    }
    throw err;
  }

  await filesCol().updateOne({ _id: upload.id }, { $set: { 'metadata.size': verifier.bytes } });

  // Two concurrent PUTs of one artifact both pass the exists check. The oldest file wins.
  const copies = await filesCol()
    .find(artifactFilter(instanceKey, captureId, artifact), { projection: { _id: 1 } })
    .sort({ uploadDate: 1, _id: 1 })
    .toArray();
  if (copies.length > 1 && !copies[0]!._id.equals(upload.id)) {
    await bucket().delete(upload.id);
    throw new ProfileUploadError(409, `${artifact} is already stored for capture ${captureId}`);
  }

  if (parsed.summary) {
    await upsertReport({
      ...parsed.summary,
      serverId: input.serverId,
      instanceKey,
      captureId,
      opId: input.opId,
      createdAt: new Date(),
    });
  }
  return { size: verifier.bytes, report: parsed.summary !== null };
}

/**
 * Stores the report of a `biforesting:spike` payload as a `kind: 'spike'` doc. A replayed payload
 * or a later report.json upload of the same capture replaces the doc. Throws a 400
 * {@link ProfileUploadError} on a report that fails the schema check.
 */
export async function storeSpikeReport(input: {
  serverId: string;
  instanceKey: string;
  report: unknown;
}): Promise<ProfileReportDoc> {
  await ensureProfileIndexes();
  const summary = summarizeProfileReport(input.report, null);
  return upsertReport({
    ...summary,
    kind: 'spike',
    serverId: input.serverId,
    instanceKey: input.instanceKey,
    captureId: summary.captureId,
    opId: null,
    createdAt: new Date(),
  });
}

/**
 * Writes a report doc. A doc that exists keeps its `createdAt`, so a replayed spike payload or a
 * later upload of the same report neither moves it in the list nor extends its retention.
 */
async function upsertReport(doc: ProfileReportDoc): Promise<ProfileReportDoc> {
  const { createdAt, ...fields } = doc;
  const stored = await reportsCol().findOneAndUpdate(
    { instanceKey: doc.instanceKey, captureId: doc.captureId },
    { $set: fields, $setOnInsert: { createdAt } },
    { upsert: true, returnDocument: 'after' },
  );
  return stored ?? doc;
}

/** Removes every trace of a failed upload. Late chunk writes are caught by the orphan sweep. */
async function discardUpload(upload: GridFSBucketWriteStream): Promise<void> {
  try {
    await upload.abort();
  } catch {
    // already aborted or finished: fall through to the explicit deletes
  }
  try {
    await chunksCol().deleteMany({ files_id: upload.id });
    await filesCol().deleteOne({ _id: upload.id });
  } catch (err) {
    logger.warn({ err, fileId: upload.id }, 'biforesting-profiles: failed to discard a rejected upload');
  }
}

export async function listArtifacts(instanceKey: string, captureId: string): Promise<StoredArtifact[]> {
  await ensureProfileIndexes();
  const files = await filesCol().find(artifactFilter(instanceKey, captureId)).sort({ uploadDate: 1 }).toArray();
  return files.map((f) => {
    const m = f.metadata as ProfileFileMeta;
    return { artifact: m.artifact, size: f.length, sha256: m.sha256, uploadedAt: f.uploadDate };
  });
}

/** Opens one artifact for download, or null when it is not stored. */
export async function openArtifact(
  instanceKey: string,
  captureId: string,
  artifact: string,
): Promise<{ file: GridFSFile; stream: Readable } | null> {
  await ensureProfileIndexes();
  const file = await filesCol().findOne(artifactFilter(instanceKey, captureId, artifact), { sort: { uploadDate: 1 } });
  if (!file) return null;
  return { file, stream: bucket().openDownloadStream(file._id) };
}

/** The full stored report.json, parsed. Null when the capture has no report yet. */
export async function readReport(instanceKey: string, captureId: string): Promise<unknown> {
  const opened = await openArtifact(instanceKey, captureId, 'report.json');
  if (!opened) return null;
  const parts: Buffer[] = [];
  for await (const chunk of opened.stream) parts.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
}

/**
 * The stored summary doc of a capture, or null. A spike dump has one before any file is fetched.
 * It holds the top hotspots, worst ticks, mods and the trigger, not the full report.
 */
export async function readReportSummary(instanceKey: string, captureId: string): Promise<ProfileReportDoc | null> {
  await ensureProfileIndexes();
  return reportsCol().findOne({ instanceKey, captureId }, { projection: { _id: 0 } });
}

// ── Queries ──────────────────────────────────────────────────────────────────

/** Mongo filter for one report kind. Docs without `kind` predate spikes and count as captures. */
function kindFilter(kind: ProfileKind): Record<string, unknown> {
  return kind === 'spike' ? { kind: 'spike' } : { kind: { $ne: 'spike' } };
}

/** Kind of a capture that has files but no report doc yet. Spike dump ids start with `spike-`. */
function kindOfId(captureId: string): ProfileKind {
  return captureId.startsWith('spike-') ? 'spike' : 'capture';
}

/**
 * Newest-first captures of one server: report summaries, plus captures with files but no report.
 * `kind` keeps only captures or only spike dumps.
 */
export async function listCaptures(instanceKey: string, limit = 50, kind?: ProfileKind): Promise<CaptureListEntry[]> {
  await ensureProfileIndexes();
  const groups = await filesCol()
    .aggregate<{
      _id: string;
      artifacts: string[];
      firstAt: Date;
      opId: string | null;
      serverId: string | null;
      bytes: number;
    }>([
      { $match: { 'metadata.instanceKey': instanceKey } },
      {
        $group: {
          _id: '$metadata.captureId',
          artifacts: { $push: '$metadata.artifact' },
          firstAt: { $min: '$uploadDate' },
          opId: { $max: '$metadata.opId' },
          serverId: { $first: '$metadata.serverId' },
          bytes: { $sum: '$length' },
        },
      },
    ])
    .toArray();
  const reports = await reportsCol()
    .find({ instanceKey, ...(kind ? kindFilter(kind) : {}) }, { projection: { hotspots: 0, worstTicks: 0, mods: 0 } })
    .toArray();

  const byId = new Map<string, CaptureListEntry>();
  for (const g of groups) {
    byId.set(g._id, {
      captureId: g._id,
      kind: kindOfId(g._id),
      trigger: null,
      opId: g.opId ?? null,
      serverId: g.serverId ?? null,
      createdAt: g.firstAt,
      hasReport: false,
      artifacts: [...g.artifacts].sort(),
      bytes: g.bytes,
    });
  }
  for (const r of reports) {
    const files = byId.get(r.captureId);
    byId.set(r.captureId, {
      captureId: r.captureId,
      kind: r.kind === 'spike' ? 'spike' : 'capture',
      trigger: r.trigger ?? null,
      opId: r.opId,
      serverId: r.serverId,
      createdAt: files && files.createdAt < r.createdAt ? files.createdAt : r.createdAt,
      hasReport: true,
      artifacts: files?.artifacts ?? [],
      bytes: files?.bytes ?? 0,
      level: r.level,
      sampler: r.sampler,
      startedAt: r.startedAt,
      durationMs: r.durationMs,
      tickCount: r.tickCount,
      mspt: r.mspt,
      tps: r.tps,
      truncated: r.truncated,
      hotspotsTotal: r.hotspotsTotal,
    });
  }
  return [...byId.values()]
    .filter((c) => !kind || c.kind === kind)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.captureId.localeCompare(a.captureId))
    .slice(0, limit);
}

/**
 * Fleet ranking: the top hotspots across each server's newest capture report, by msPerTick. Spike
 * dumps stay out: a 13 s window around one long tick says little about steady cost.
 */
export async function fleetHotspots(query: { top: number; kind?: string; mod?: string }): Promise<FleetHotspot[]> {
  await ensureProfileIndexes();
  const match: Record<string, unknown> = {};
  if (query.kind) match['hotspot.kind'] = query.kind;
  if (query.mod) match['hotspot.mod'] = query.mod;
  const rows = await reportsCol()
    .aggregate<{ _id: string; serverId: string; captureId: string; createdAt: Date; hotspot: Record<string, unknown> }>([
      { $match: kindFilter('capture') },
      { $sort: { instanceKey: 1, createdAt: -1 } },
      {
        $group: {
          _id: '$instanceKey',
          serverId: { $first: '$serverId' },
          captureId: { $first: '$captureId' },
          createdAt: { $first: '$createdAt' },
          hotspots: { $first: '$hotspots' },
        },
      },
      { $unwind: { path: '$hotspots' } },
      { $project: { serverId: 1, captureId: 1, createdAt: 1, hotspot: '$hotspots' } },
      ...(Object.keys(match).length > 0 ? [{ $match: match }] : []),
      { $sort: { 'hotspot.msPerTick': -1, _id: 1 } },
      { $limit: query.top },
    ])
    .toArray();
  return rows.map((r) => ({
    ...r.hotspot,
    server: r._id,
    serverId: r.serverId,
    captureId: r.captureId,
    createdAt: r.createdAt,
  }));
}

// ── Retention ────────────────────────────────────────────────────────────────

/**
 * Deletes whole captures (every file plus the report doc) once any part of them is older than
 * the retention window. It also removes chunks that lost their file doc.
 */
export async function cleanupProfiles(
  now: Date = new Date(),
): Promise<{ captures: number; files: number; reports: number; orphanChunks: number }> {
  await ensureProfileIndexes();
  const cutoff = new Date(now.getTime() - PROFILE_RETENTION_MS);
  const stale = new Map<string, { instanceKey: string; captureId: string }>();
  const add = (instanceKey: string, captureId: string): void => {
    stale.set(`${instanceKey}\u0000${captureId}`, { instanceKey, captureId });
  };
  for (const f of await filesCol().find({ uploadDate: { $lt: cutoff } }, { projection: { metadata: 1 } }).toArray()) {
    const m = f.metadata as ProfileFileMeta | undefined;
    if (m?.instanceKey && m.captureId) add(m.instanceKey, m.captureId);
  }
  for (const r of await reportsCol()
    .find({ createdAt: { $lt: cutoff } }, { projection: { instanceKey: 1, captureId: 1 } })
    .toArray()) {
    add(r.instanceKey, r.captureId);
  }

  let files = 0;
  let reports = 0;
  for (const { instanceKey, captureId } of stale.values()) {
    const ids = await filesCol().find(artifactFilter(instanceKey, captureId), { projection: { _id: 1 } }).toArray();
    for (const { _id } of ids) {
      try {
        await bucket().delete(_id);
        files++;
      } catch (err) {
        logger.debug({ err, fileId: _id }, 'biforesting-profiles: file delete raced');
      }
    }
    reports += (await reportsCol().deleteOne({ instanceKey, captureId })).deletedCount;
  }

  const orphanChunks = await sweepOrphanChunks(now);
  return { captures: stale.size, files, reports, orphanChunks };
}

async function sweepOrphanChunks(now: Date): Promise<number> {
  const cutoffId = ObjectId.createFromTime(Math.floor((now.getTime() - ORPHAN_GRACE_MS) / 1000));
  const orphans = await chunksCol()
    .aggregate<{ _id: ObjectId }>([
      { $match: { files_id: { $lt: cutoffId } } },
      { $group: { _id: '$files_id' } },
      { $lookup: { from: `${BUCKET}.files`, localField: '_id', foreignField: '_id', as: 'file' } },
      { $match: { file: { $size: 0 } } },
      { $project: { _id: 1 } },
    ])
    .toArray();
  if (orphans.length === 0) return 0;
  const res = await chunksCol().deleteMany({ files_id: { $in: orphans.map((o) => o._id) } });
  return res.deletedCount;
}

/** Hourly retention sweep. Returns the stop function. */
export function startProfileCleanup(): () => void {
  const timer = setInterval(() => {
    void cleanupProfiles()
      .then((r) => {
        if (r.captures > 0 || r.orphanChunks > 0) logger.info(r, 'biforesting-profiles: retention sweep');
      })
      .catch((err) => logger.warn({ err }, 'biforesting-profiles: retention sweep failed'));
  }, CLEANUP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
