import { createHmac, randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../../config/index.js';
import { logger } from '../../core/logger/index.js';
import { apiKeyAuth } from '../../middleware/auth/api-key.js';
import { getAuthKey } from '../../plugins/biforesting-link/auth-key.js';
import { opDispatcher, opsStore } from '../../plugins/biforesting-link/ops-runtime.js';
import { FEATURE_BITS, getPolicy } from '../../plugins/biforesting-link/policy-store.js';
import {
  bindGrantCapture,
  fleetHotspots,
  findUploadGrant,
  listArtifacts,
  listCaptures,
  openArtifact,
  readReport,
  readReportSummary,
  storeArtifact,
} from '../../plugins/biforesting-link/profile-store.js';
import {
  MAX_ARTIFACT_BYTES,
  PROFILE_ARTIFACTS,
  ProfileUploadError,
  verifyUpload,
} from '../../plugins/biforesting-link/profile-upload.js';
import { serverResolver } from '../../plugins/biforesting-link/server-resolver.js';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '../../shared/errors/index.js';
import { perfettoPageHtml } from './perfetto-page.js';
import {
  PROFILE_BUDGET,
  PROFILE_COUNTED_STATES,
  PROFILE_OP_EXPIRES_MS,
  profileBudgetError,
  profileCaptureExecTimeoutMs,
} from './profile-budget.js';
import type {
  FleetHotspotsQuery,
  LinkServerParams,
  ProfileArtifactParams,
  ProfileCaptureBody,
  ProfileListQuery,
  ProfileParams,
  ProfileViewQuery,
} from './biforesting.schema.js';

const VIEW_TOKEN_TTL_S = 15 * 60;
const VIEW_AUDIENCE = 'bf-profile-view';

/** Refuses an op type whose policy feature bit is off for the server. */
export async function assertFeatureGranted(instanceKey: string, feature: string, server: string): Promise<void> {
  const policy = await getPolicy(instanceKey);
  if ((policy.enabledFeatures & (FEATURE_BITS[feature] ?? 0)) === 0) {
    throw new ForbiddenError(
      `feature '${feature}' is not granted for ${instanceKey}. Grant it with PUT /v1/biforesting/${server}/policy first.`,
    );
  }
}

/** 409 when a capture is outside tier B and the caller did not confirm. */
export async function assertProfileBudget(
  instanceKey: string,
  params: { seconds: number; level: string },
  confirmed: boolean,
): Promise<void> {
  if (confirmed) return;
  const since = new Date(Date.now() - PROFILE_BUDGET.windowMs);
  const last = await opsStore.latestOfType(instanceKey, 'profile_capture', since, PROFILE_COUNTED_STATES);
  const reason = profileBudgetError(params, last?.createdAt ?? null);
  if (reason) throw new ConflictError(reason);
}

/**
 * Read access to one capture's trace: the API key, or a view token from POST .../perfetto-link.
 * The token is bound to the exact server segment and captureId and only opens trace.json.gz.
 */
export function profileTraceAuth(): RequestHandler {
  const byApiKey = apiKeyAuth();
  return (req: Request, res: Response, next: NextFunction): void => {
    const t = req.query['t'];
    if (typeof t !== 'string') {
      byApiKey(req, res, next);
      return;
    }
    const claims = verifyViewToken(t);
    const params = req.params as Record<string, string | undefined>;
    if (
      claims &&
      claims.server === params['server'] &&
      claims.captureId === params['captureId'] &&
      params['artifact'] === 'trace.json.gz'
    ) {
      next();
      return;
    }
    next(new UnauthorizedError('Invalid or expired view token'));
  };
}

/**
 * The view token key is derived from JWT_SECRET, so a view token never verifies as a user JWT
 * and a user JWT never opens a trace.
 */
function viewKey(): Buffer {
  return createHmac('sha256', config.JWT_SECRET).update('biforesting-profile-view').digest();
}

function signViewToken(server: string, captureId: string): { token: string; expiresAt: Date } {
  const token = jwt.sign({ s: server, c: captureId }, viewKey(), { expiresIn: VIEW_TOKEN_TTL_S, audience: VIEW_AUDIENCE });
  return { token, expiresAt: new Date(Date.now() + VIEW_TOKEN_TTL_S * 1000) };
}

function verifyViewToken(token: string): { server: string; captureId: string } | null {
  try {
    const claims = jwt.verify(token, viewKey(), { audience: VIEW_AUDIENCE }) as { s?: unknown; c?: unknown };
    if (typeof claims.s !== 'string' || typeof claims.c !== 'string') return null;
    return { server: claims.s, captureId: claims.c };
  } catch {
    return null;
  }
}

async function resolveKnown(server: string): Promise<{ instanceKey: string; tag: string | null }> {
  const identity = await serverResolver.resolve(server);
  if (!identity.resolved) throw new ValidationError(`Unknown server '${server}'`);
  return identity;
}

export class ProfilesController {
  /** Enqueue a profile_capture through the normal op path. */
  createCapture = async (req: Request, res: Response): Promise<void> => {
    const { server } = req.params as unknown as LinkServerParams;
    const { confirm, ...params } = req.body as ProfileCaptureBody;
    const identity = await resolveKnown(server);
    await assertFeatureGranted(identity.instanceKey, 'profiler', server);
    await assertProfileBudget(identity.instanceKey, params, confirm === true);

    const { op } = await opsStore.create({
      instanceKey: identity.instanceKey,
      serverTag: identity.tag,
      type: 'profile_capture',
      params,
      flags: confirm === true ? { confirm: true } : {},
      execTimeoutMs: profileCaptureExecTimeoutMs(params.seconds),
      expiresInMs: PROFILE_OP_EXPIRES_MS,
      createdBy: (req.headers['x-actor'] as string | undefined) ?? 'api:profiles',
    });
    await opDispatcher.onOpCreated(op);
    const current = (await opsStore.get(op._id)) ?? op;
    res.status(201).json({ data: { opId: op._id, state: current.state, instanceKey: identity.instanceKey, params } });
  };

  listCaptures = async (req: Request, res: Response): Promise<void> => {
    const { server } = req.params as unknown as LinkServerParams;
    const { limit, kind } = req.query as unknown as ProfileListQuery;
    const identity = await serverResolver.resolve(server);
    const captures = await listCaptures(identity.instanceKey, limit, kind);
    res.json({ data: { instanceKey: identity.instanceKey, count: captures.length, captures } });
  };

  /**
   * The full stored report.json plus the list of stored artifacts. Without a report.json file the
   * stored summary stands in (`reportSource: 'summary'`), so a spike dump reads before any fetch.
   */
  getCapture = async (req: Request, res: Response): Promise<void> => {
    const { server, captureId } = req.params as unknown as ProfileParams;
    const identity = await serverResolver.resolve(server);
    const artifacts = await listArtifacts(identity.instanceKey, captureId);
    const hasFile = artifacts.some((a) => a.artifact === 'report.json');
    const report = hasFile
      ? await readReport(identity.instanceKey, captureId)
      : await readReportSummary(identity.instanceKey, captureId);
    if (artifacts.length === 0 && !report) throw new NotFoundError('Capture', `${captureId} on ${identity.instanceKey}`);
    const reportSource = hasFile ? 'file' : report ? 'summary' : null;
    res.json({ data: { instanceKey: identity.instanceKey, captureId, artifacts, report, reportSource } });
  };

  getArtifact = async (req: Request, res: Response): Promise<void> => {
    const { server, captureId, artifact } = req.params as unknown as ProfileArtifactParams;
    const identity = await serverResolver.resolve(server);
    const opened = await openArtifact(identity.instanceKey, captureId, artifact);
    if (!opened) throw new NotFoundError('Artifact', `${captureId}/${artifact} on ${identity.instanceKey}`);
    const meta = opened.file.metadata as { sha256?: string } | undefined;
    res.setHeader('Content-Type', PROFILE_ARTIFACTS[artifact]);
    res.setHeader('Content-Length', String(opened.file.length));
    res.setHeader('Content-Disposition', `attachment; filename="${captureId}-${artifact}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    if (meta?.sha256) res.setHeader('X-Bf-Content-Sha256', meta.sha256);
    try {
      await pipeline(opened.stream, res);
    } catch (err) {
      // After the first byte the status is sent. A client that hangs up lands here too.
      if (!res.headersSent) throw err;
      logger.debug({ err, captureId, artifact }, 'biforesting-profiles: download ended early');
    }
  };

  /**
   * Artifact upload from a linked server. No API key: the upload token from the op params plus
   * an authKey HMAC authenticate it (see profile-upload.ts for the wire contract).
   */
  putArtifact = async (req: Request, res: Response): Promise<void> => {
    try {
      const { server, captureId, artifact } = req.params as unknown as ProfileArtifactParams;
      const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (type !== 'application/octet-stream') {
        throw new ProfileUploadError(415, 'Content-Type must be application/octet-stream');
      }
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_ARTIFACT_BYTES) {
        throw new ProfileUploadError(413, `artifact is over the ${MAX_ARTIFACT_BYTES} byte limit`);
      }
      let key: Buffer;
      try {
        key = getAuthKey();
      } catch {
        throw new ProfileUploadError(503, 'profile uploads need the link authKey (BIFORESTING_PSK)');
      }

      const header = (name: string): string | undefined => {
        const v = req.headers[name];
        return typeof v === 'string' ? v.trim() : undefined;
      };
      const token = header('x-bf-upload-token');
      const grant = token ? await findUploadGrant(token) : null;
      const identity = await serverResolver.resolve(server);
      const verdict = verifyUpload(
        {
          serverId: server,
          captureId,
          artifact,
          instanceKey: identity.instanceKey,
          token,
          timestamp: header('x-bf-timestamp'),
          contentSha256: header('x-bf-content-sha256'),
          signature: header('x-bf-signature'),
        },
        grant,
        key,
        Date.now(),
      );
      if (!verdict.ok) throw new ProfileUploadError(verdict.status, verdict.reason);
      if (!grant || !(await bindGrantCapture(grant.token, captureId))) {
        throw new ProfileUploadError(403, 'upload token is bound to another capture');
      }

      const stored = await storeArtifact({
        source: req,
        serverId: server,
        instanceKey: grant.instanceKey,
        captureId,
        artifact,
        sha256: verdict.contentSha256,
        opId: grant.opId,
      });
      res.status(201).json({
        data: { captureId, artifact, size: stored.size, sha256: verdict.contentSha256, report: stored.report },
      });
    } catch (err) {
      // An early reject leaves the body unread. Close the socket so it is not reused.
      if (!req.complete) res.setHeader('Connection', 'close');
      throw err;
    }
  };

  /** Fleet-wide hotspot ranking from each server's newest report. */
  getFleetHotspots = async (req: Request, res: Response): Promise<void> => {
    const { top, kind, mod } = req.query as unknown as FleetHotspotsQuery;
    const hotspots = await fleetHotspots({ top, ...(kind ? { kind } : {}), ...(mod ? { mod } : {}) });
    res.json({ data: { count: hotspots.length, hotspots } });
  };

  /** Mints a 15 min link to the Perfetto page for one capture. */
  createPerfettoLink = async (req: Request, res: Response): Promise<void> => {
    const { server, captureId } = req.params as unknown as ProfileParams;
    const identity = await serverResolver.resolve(server);
    const artifacts = await listArtifacts(identity.instanceKey, captureId);
    if (!artifacts.some((a) => a.artifact === 'trace.json.gz')) {
      throw new NotFoundError('Artifact', `${captureId}/trace.json.gz on ${identity.instanceKey}`);
    }
    const { token, expiresAt } = signViewToken(server, captureId);
    const path = `${req.baseUrl}/${encodeURIComponent(server)}/profiles/${captureId}/perfetto?t=${encodeURIComponent(token)}`;
    res.json({
      data: { path, url: `${config.BIFORESTING_PUBLIC_URL.replace(/\/+$/, '')}${path}`, expiresAt },
    });
  };

  /** The Perfetto hand-off page. Needs the view token from createPerfettoLink. */
  getPerfettoPage = (req: Request, res: Response): void => {
    const { server, captureId } = req.params as unknown as ProfileParams;
    const { t } = req.query as unknown as ProfileViewQuery;
    const claims = t ? verifyViewToken(t) : null;
    if (!claims || claims.server !== server || claims.captureId !== captureId) {
      throw new UnauthorizedError('Invalid or expired view token. Mint a new link with POST .../perfetto-link.');
    }
    const nonce = randomBytes(16).toString('base64');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    // The page must keep its handle on the Perfetto popup for postMessage.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(
      perfettoPageHtml({
        title: `${server} ${captureId}`,
        traceUrl: `trace.json.gz?t=${encodeURIComponent(t!)}`,
        nonce,
      }),
    );
  };
}
