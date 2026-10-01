import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { AppError } from '../../shared/errors/index.js';
import { REPLAY_WINDOW_MS } from './frame-codec.js';

/**
 * Pure parts of the profiler artifact upload (profiler plan phase 4). The mod PUTs each artifact
 * over plain HTTP, off the WS link:
 *
 *   PUT /v1/biforesting/:server/profiles/:captureId/:artifact
 *   Content-Type: application/octet-stream
 *   X-Bf-Upload-Token:   the `uploadToken` op param
 *   X-Bf-Timestamp:      epoch ms
 *   X-Bf-Content-Sha256: lowercase hex sha256 of the body
 *   X-Bf-Signature:      hex HMAC-SHA256(authKey, signing string)
 *
 * Signing string: serverId, captureId, artifact, contentSha256 and timestamp, joined by "\n".
 * `serverId` is the `:server` path segment. Yggdrasil sets it to the mod's own link serverId.
 */

export const PROFILE_ARTIFACTS = {
  'report.json': 'application/json; charset=utf-8',
  'report.md': 'text/markdown; charset=utf-8',
  'trace.json.gz': 'application/gzip',
  'samples.collapsed': 'text/plain; charset=utf-8',
  'samples.jfr': 'application/octet-stream',
} as const;

export type ProfileArtifact = keyof typeof PROFILE_ARTIFACTS;
export const PROFILE_ARTIFACT_NAMES = Object.keys(PROFILE_ARTIFACTS) as [ProfileArtifact, ...ProfileArtifact[]];

export const CAPTURE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
/** report.json is parsed in memory, so it gets a lower cap. 1000 hotspots come to about 1.5 MB. */
export const MAX_REPORT_BYTES = 16 * 1024 * 1024;
export const UPLOAD_WINDOW_MS = REPLAY_WINDOW_MS;
export const REPORT_SCHEMA = 1;
export const REPORT_TOP_HOTSPOTS = 50;

/** Carries the HTTP status. The global error handler renders it like any AppError. */
export class ProfileUploadError extends AppError {
  constructor(status: number, message: string) {
    super(message, status, UPLOAD_ERROR_CODES[status] ?? 'UPLOAD_REJECTED');
  }
}

const UPLOAD_ERROR_CODES: Record<number, string> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  503: 'UNAVAILABLE',
};

export function uploadSigningString(
  serverId: string,
  captureId: string,
  artifact: string,
  contentSha256: string,
  timestamp: number | string,
): string {
  return `${serverId}\n${captureId}\n${artifact}\n${contentSha256}\n${timestamp}`;
}

export function signUpload(
  key: Buffer,
  serverId: string,
  captureId: string,
  artifact: string,
  contentSha256: string,
  timestamp: number | string,
): string {
  return createHmac('sha256', key)
    .update(uploadSigningString(serverId, captureId, artifact, contentSha256, timestamp), 'utf8')
    .digest('hex');
}

/** The upload headers as received. Any of them can be missing. */
export interface UploadHeaders {
  token?: string;
  timestamp?: string;
  contentSha256?: string;
  signature?: string;
}

/** The stored grant fields that the check reads. */
export interface UploadGrantView {
  instanceKey: string;
  captureId: string | null;
  expiresAt: Date;
}

export interface UploadRequest extends UploadHeaders {
  /** The `:server` path segment, as signed by the mod. */
  serverId: string;
  captureId: string;
  artifact: string;
  /** instanceKey that `serverId` resolves to. */
  instanceKey: string;
}

export type UploadVerdict =
  | { ok: true; contentSha256: string }
  | { ok: false; status: number; reason: string };

const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const TS_RE = /^\d{1,16}$/;

/**
 * Header, timestamp, signature and grant checks for one upload, in that order. The body hash is
 * checked later, while the body streams ({@link ArtifactVerifier}).
 */
export function verifyUpload(req: UploadRequest, grant: UploadGrantView | null, key: Buffer, now: number): UploadVerdict {
  if (!req.token || !TOKEN_RE.test(req.token)) return deny(401, 'missing or malformed X-Bf-Upload-Token');
  if (!req.timestamp || !TS_RE.test(req.timestamp)) return deny(400, 'missing or malformed X-Bf-Timestamp (epoch ms)');
  if (!req.contentSha256 || !HEX64_RE.test(req.contentSha256)) {
    return deny(400, 'missing or malformed X-Bf-Content-Sha256 (64 hex chars)');
  }
  if (!req.signature || !HEX64_RE.test(req.signature)) return deny(401, 'missing or malformed X-Bf-Signature (64 hex chars)');

  const ts = Number(req.timestamp);
  if (Math.abs(now - ts) > UPLOAD_WINDOW_MS) {
    return deny(401, `X-Bf-Timestamp is outside the ${UPLOAD_WINDOW_MS / 1000} s window`);
  }

  const sha = req.contentSha256.toLowerCase();
  const expected = createHmac('sha256', key)
    .update(uploadSigningString(req.serverId, req.captureId, req.artifact, sha, req.timestamp), 'utf8')
    .digest();
  const given = Buffer.from(req.signature, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return deny(401, 'signature mismatch');

  if (!grant) return deny(401, 'unknown upload token');
  if (grant.expiresAt.getTime() <= now) return deny(401, 'upload token expired');
  if (grant.instanceKey !== req.instanceKey) return deny(403, 'upload token belongs to another server');
  if (grant.captureId !== null && grant.captureId !== req.captureId) {
    return deny(403, `upload token is bound to capture ${grant.captureId}`);
  }
  return { ok: true, contentSha256: sha };
}

function deny(status: number, reason: string): UploadVerdict {
  return { ok: false, status, reason };
}

/**
 * Pass-through stream that hashes and counts the body. It fails on the byte cap, and in flush
 * when the sha256 differs from the header. A failure before flush ends keeps the GridFS file doc
 * from being written. `onBody` gets the whole body after the hash check (report.json only).
 */
export class ArtifactVerifier extends Transform {
  bytes = 0;
  private readonly hash = createHash('sha256');
  private readonly parts: Buffer[] | null;

  constructor(
    private readonly expectedSha256: string,
    private readonly maxBytes: number,
    private readonly onBody?: (body: Buffer) => void,
  ) {
    super();
    this.parts = onBody ? [] : null;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      cb(new ProfileUploadError(413, `artifact is over the ${this.maxBytes} byte limit`));
      return;
    }
    this.hash.update(chunk);
    this.parts?.push(chunk);
    cb(null, chunk);
  }

  override _flush(cb: TransformCallback): void {
    const got = this.hash.digest('hex');
    if (got !== this.expectedSha256) {
      cb(new ProfileUploadError(400, `body sha256 ${got} does not match X-Bf-Content-Sha256`));
      return;
    }
    if (this.onBody && this.parts) {
      try {
        this.onBody(Buffer.concat(this.parts));
      } catch (err) {
        cb(err as Error);
        return;
      }
    }
    cb();
  }
}

// ── report.json ──────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

export type ProfileKind = 'capture' | 'spike';
export const PROFILE_KINDS = ['capture', 'spike'] as const;

/** The queryable part of a schema-1 report. The full file stays in GridFS. */
export interface ProfileReportSummary {
  schema: number;
  /** `spike` for a spike catcher dump (the report carries `kind: "spike"`), else `capture`. */
  kind: ProfileKind;
  /** The spike dump's trigger block: tickMs, thresholdMs, tick, suppressed and more. Null for a capture. */
  trigger: Json | null;
  startedAt: Date | null;
  stoppedAt: Date | null;
  level: string | null;
  sampler: string | null;
  durationMs: number;
  tickCount: number;
  analysisTicks: number;
  mspt: { p50: number; p95: number; p99: number; max: number; avg: number };
  tps: number;
  truncated: boolean;
  stopReason: string | null;
  hotspotsTotal: number;
  mods: Json[];
  hotspots: Json[];
  worstTicks: Json[];
}

/** Parses and checks a report.json body. Throws a 400 {@link ProfileUploadError} on bad input. */
export function parseProfileReport(body: Buffer, captureId: string): ProfileReportSummary {
  let raw: unknown;
  try {
    raw = JSON.parse(body.toString('utf8'));
  } catch (err) {
    throw new ProfileUploadError(400, `report.json does not parse: ${(err as Error).message}`);
  }
  return summarizeProfileReport(raw, captureId);
}

/**
 * Checks an already parsed report. `captureId` is the id it must carry, or null to take the
 * report's own id (the spike channel has no URL). Throws a 400 {@link ProfileUploadError}.
 */
export function summarizeProfileReport(raw: unknown, captureId: string | null): ProfileReportSummary & { captureId: string } {
  if (!isObject(raw)) throw new ProfileUploadError(400, 'report.json must be a JSON object');
  if (raw['schema'] !== REPORT_SCHEMA) {
    throw new ProfileUploadError(400, `report.json schema ${JSON.stringify(raw['schema'])} is not supported (want ${REPORT_SCHEMA})`);
  }
  if (captureId !== null && typeof raw['captureId'] === 'string' && raw['captureId'] !== captureId) {
    throw new ProfileUploadError(400, `report.json captureId ${raw['captureId']} does not match the URL (${captureId})`);
  }
  const id = captureId ?? raw['captureId'];
  if (typeof id !== 'string' || !CAPTURE_ID_RE.test(id)) {
    throw new ProfileUploadError(400, `report.json captureId ${JSON.stringify(raw['captureId'])} is missing or malformed`);
  }
  const mspt = isObject(raw['mspt']) ? raw['mspt'] : {};
  const trigger = isObject(raw['trigger']) ? raw['trigger'] : null;
  return {
    captureId: id,
    schema: REPORT_SCHEMA,
    kind: raw['kind'] === 'spike' ? 'spike' : 'capture',
    trigger,
    startedAt: date(raw['startedAt']),
    stoppedAt: date(raw['stoppedAt']),
    level: str(raw['level']),
    sampler: str(raw['sampler']),
    durationMs: num(raw['durationMs']),
    tickCount: num(raw['tickCount']),
    analysisTicks: num(raw['analysisTicks']),
    mspt: { p50: num(mspt['p50']), p95: num(mspt['p95']), p99: num(mspt['p99']), max: num(mspt['max']), avg: num(mspt['avg']) },
    tps: num(raw['tps']),
    truncated: raw['truncated'] === true,
    stopReason: str(raw['stopReason']),
    hotspotsTotal: num(raw['hotspotsTotal']),
    mods: objects(raw['mods']),
    hotspots: objects(raw['hotspots']).slice(0, REPORT_TOP_HOTSPOTS),
    worstTicks: objects(raw['worstTicks']),
  };
}

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function objects(v: unknown): Json[] {
  return Array.isArray(v) ? v.filter(isObject) : [];
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function date(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
