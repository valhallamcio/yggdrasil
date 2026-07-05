import type { Request, Response } from 'express';
import { biforestingLinkManager } from '../../plugins/biforesting-link/link-manager.js';
import { encodeQuestDown, encodeChunksDown } from '../../plugins/biforesting-link/decoders.js';
import { getPolicy, setPolicy, maskForFeatures, featureNamesForMask } from '../../plugins/biforesting-link/policy-store.js';
import { opDispatcher, opsStore } from '../../plugins/biforesting-link/ops-runtime.js';
import { latestStored, rawHistory, hourlyHistory } from '../../plugins/biforesting-link/metrics-history.js';
import { serverResolver } from '../../plugins/biforesting-link/server-resolver.js';
import { NotFoundError, ValidationError } from '../../shared/errors/index.js';
import { catalogEntry, OPS_CATALOG } from './ops-catalog.js';
import type { LinkServerParams, PolicyPutBody, QuestDownBody, ChunksDownBody, OpCreateBody, OpIdParams, OpListQuery, MetricsHistoryQuery } from './biforesting.schema.js';

const QUEST_CHANNEL = 'biforesting:quest';
const CHUNKS_CHANNEL = 'biforesting:chunks';

export class BiforestingController {
  /** Observability: snapshot of all live link sessions. */
  getLink = (_req: Request, res: Response): void => {
    res.json({ data: biforestingLinkManager.getSnapshot() });
  };

  /** Observability: one session by server identifier. */
  getLinkOne = (req: Request, res: Response): void => {
    const { server } = req.params as unknown as LinkServerParams;
    const session = biforestingLinkManager.getSessionSnapshot(server);
    if (!session) throw new NotFoundError('Link session', server);
    res.json({ data: session });
  };

  /** Metrics v2: the live session's last sample, else the newest stored raw sample. */
  getMetricsLatest = async (req: Request, res: Response): Promise<void> => {
    const { server } = req.params as unknown as LinkServerParams;
    const identity = await serverResolver.resolve(server);
    const session = biforestingLinkManager.getSessionByServer(server);
    if (session?.metrics) {
      res.json({
        data: { instanceKey: identity.instanceKey, source: 'live', at: new Date().toISOString(), metrics: session.metrics },
      });
      return;
    }
    const stored = await latestStored(identity.instanceKey);
    if (!stored) throw new NotFoundError('Metrics', identity.instanceKey);
    res.json({
      data: { instanceKey: identity.instanceKey, source: 'stored', at: stored.at.toISOString(), metrics: stored.metrics },
    });
  };

  /** Metrics v2 history: raw (72 h TTL) or hourly downsample (30 d TTL). */
  getMetricsHistory = async (req: Request, res: Response): Promise<void> => {
    const { server } = req.params as unknown as LinkServerParams;
    const query = req.query as unknown as MetricsHistoryQuery;
    const identity = await serverResolver.resolve(server);
    if (query.res === 'hourly') {
      const points = await hourlyHistory(identity.instanceKey, query.sinceHours ?? 168);
      res.json({ data: { instanceKey: identity.instanceKey, res: 'hourly', count: points.length, points } });
      return;
    }
    const points = await rawHistory(identity.instanceKey, query.sinceHours ?? 6);
    res.json({ data: { instanceKey: identity.instanceKey, res: 'raw', count: points.length, points } });
  };

  /** The stored link policy for a server (ZERO for unknown — features default off). */
  getPolicy = async (req: Request, res: Response): Promise<void> => {
    const { server } = req.params as unknown as LinkServerParams;
    const identity = await serverResolver.resolve(server);
    const policy = await getPolicy(identity.instanceKey);
    res.json({
      data: {
        instanceKey: identity.instanceKey,
        resolved: identity.resolved,
        ...policy,
        features: featureNamesForMask(policy.enabledFeatures),
        liveSession: !!biforestingLinkManager.getSessionByServer(server),
      },
    });
  };

  /**
   * Upsert the link policy and, when the backend has a live session, re-send reg_ack so the
   * change applies IMMEDIATELY (per-server kill switch / grant without redeploy or reconnect).
   */
  putPolicy = async (req: Request, res: Response): Promise<void> => {
    const { server } = req.params as unknown as LinkServerParams;
    const body = req.body as PolicyPutBody;

    const identity = await serverResolver.resolve(server);
    if (!identity.resolved) {
      throw new ValidationError(`Unknown server '${server}' — policy must target a resolvable server`);
    }

    const fields: { enabledFeatures?: number; metricsHz?: number; questHz?: number; chunkHz?: number } = {};
    if (body.features !== undefined) fields.enabledFeatures = maskForFeatures(body.features);
    if (body.enabledFeatures !== undefined) fields.enabledFeatures = body.enabledFeatures;
    if (body.metricsHz !== undefined) fields.metricsHz = body.metricsHz;
    if (body.questHz !== undefined) fields.questHz = body.questHz;
    if (body.chunkHz !== undefined) fields.chunkHz = body.chunkHz;
    if (Object.keys(fields).length === 0) throw new ValidationError('No policy fields to update');

    const actor = (req.headers['x-actor'] as string | undefined) ?? 'api';
    const doc = await setPolicy(identity.instanceKey, fields, actor);
    const reAcked = await biforestingLinkManager.resendRegAck(server);
    res.json({
      data: {
        instanceKey: identity.instanceKey,
        enabledFeatures: doc.enabledFeatures,
        features: featureNamesForMask(doc.enabledFeatures),
        metricsHz: doc.metricsHz,
        questHz: doc.questHz,
        chunkHz: doc.chunkHz,
        reAcked,
      },
    });
  };

  // ── Durable ops ─────────────────────────────────────────────────────────────

  /**
   * Create a durable op for a backend. Validated against the ops catalog; an `idempotencyKey`
   * replay returns the existing op (201 only for a fresh insert). Dispatches immediately when the
   * backend has a live link; otherwise the op waits durably for link-up.
   */
  createOp = async (req: Request, res: Response): Promise<void> => {
    const { server } = req.params as unknown as LinkServerParams;
    const body = req.body as OpCreateBody;

    const entry = catalogEntry(body.type);
    if (!entry) {
      throw new ValidationError(`Unknown op type '${body.type}' — known: ${Object.keys(OPS_CATALOG).join(', ')}`);
    }
    const parsed = entry.params.safeParse(body.params);
    if (!parsed.success) {
      throw new ValidationError(`Invalid params for '${body.type}': ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    if (!entry.serverGlobal && !body.target) {
      throw new ValidationError(`Op type '${body.type}' requires a target player`);
    }

    const identity = await serverResolver.resolve(server);
    if (!identity.resolved) {
      throw new ValidationError(`Unknown server '${server}' — ops must target a resolvable server`);
    }

    const createdBy = (req.headers['x-actor'] as string | undefined) ?? 'api';
    const { op, replayed } = await opsStore.create({
      instanceKey: identity.instanceKey,
      serverTag: identity.tag,
      type: body.type,
      params: parsed.data as Record<string, unknown>,
      target: body.target ?? null,
      flags: body.flags ?? {},
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
      notBefore: body.notBefore ?? null,
      ...(body.expiresInMs !== undefined ? { expiresInMs: body.expiresInMs } : {}),
      ...(body.maxAttempts !== undefined ? { maxAttempts: body.maxAttempts } : {}),
      ...(body.dispatchTimeoutMs !== undefined ? { dispatchTimeoutMs: body.dispatchTimeoutMs } : {}),
      ...(body.execTimeoutMs !== undefined ? { execTimeoutMs: body.execTimeoutMs } : {}),
      createdBy,
    });

    if (!replayed) await opDispatcher.onOpCreated(op);
    const current = (await opsStore.get(op._id)) ?? op;
    res.status(replayed ? 200 : 201).json({ data: { op: current, replayed } });
  };

  getOp = async (req: Request, res: Response): Promise<void> => {
    const { opId } = req.params as unknown as OpIdParams;
    const op = await opsStore.get(opId);
    if (!op) throw new NotFoundError('Op', opId);
    res.json({ data: op });
  };

  listOps = async (req: Request, res: Response): Promise<void> => {
    const { server } = req.params as unknown as LinkServerParams;
    const query = req.query as unknown as OpListQuery;
    const identity = await serverResolver.resolve(server);
    const ops = await opsStore.list(
      { instanceKey: identity.instanceKey, ...(query.state ? { state: query.state } : {}), ...(query.type ? { type: query.type } : {}) },
      query.limit,
    );
    res.json({ data: { instanceKey: identity.instanceKey, ops, count: ops.length } });
  };

  cancelOp = async (req: Request, res: Response): Promise<void> => {
    const { opId } = req.params as unknown as OpIdParams;
    const existing = await opsStore.get(opId);
    if (!existing) throw new NotFoundError('Op', opId);
    const by = (req.headers['x-actor'] as string | undefined) ?? 'api';
    const cancelled = await opsStore.cancel(opId, by);
    if (!cancelled) {
      throw new ValidationError(`Op ${opId} is '${existing.state}' — only pending/dispatched/waiting_player ops can be cancelled`);
    }
    res.json({ data: cancelled });
  };

  /** The op catalog (types, param shapes are internal — expose names, risk, target requirement). */
  getOpsCatalog = (_req: Request, res: Response): void => {
    res.json({
      data: Object.entries(OPS_CATALOG).map(([type, e]) => ({
        type,
        serverGlobal: e.serverGlobal,
        risk: e.risk,
        description: e.description,
      })),
    });
  };

  /**
   * DOWN: push authoritative quest progress (full replace per team). Guarded — the mod runs no
   * DataFixerUpper and Node has none, so we only push when every team's dataVersion matches the
   * instance's last-seen UP dataVersion. Caller must DFU the SNBT to that version first.
   */
  pushQuest = (req: Request, res: Response): void => {
    const { server } = req.params as unknown as LinkServerParams;
    const { teams } = req.body as QuestDownBody;

    const target = biforestingLinkManager.getLastDataVersion(server);
    if (target === null) {
      throw new ValidationError(
        'Cannot push quest: no quest dataVersion observed from this server yet (needed to verify SNBT compatibility — Yggdrasil cannot DataFix in Node)',
      );
    }
    const mismatch = teams.find((t) => t.dataVersion !== target);
    if (mismatch) {
      throw new ValidationError(
        `Cannot push quest: team ${mismatch.teamId} dataVersion ${mismatch.dataVersion} != server dataVersion ${target}. DFU the SNBT to ${target} before pushing.`,
      );
    }

    const sent = biforestingLinkManager.sendDown(server, QUEST_CHANNEL, encodeQuestDown(teams));
    if (!sent) throw new NotFoundError('Live link session', server);
    res.json({ data: { sent: true, channel: QUEST_CHANNEL, teams: teams.length, dataVersion: target } });
  };

  /** DOWN: push a desired land-claim set per team (reconcile-to-desired, idempotent). */
  pushChunks = (req: Request, res: Response): void => {
    const { server } = req.params as unknown as LinkServerParams;
    const { teams } = req.body as ChunksDownBody;

    const sent = biforestingLinkManager.sendDown(server, CHUNKS_CHANNEL, encodeChunksDown(teams));
    if (!sent) throw new NotFoundError('Live link session', server);
    const claims = teams.reduce((n, t) => n + t.claims.length, 0);
    res.json({ data: { sent: true, channel: CHUNKS_CHANNEL, teams: teams.length, claims } });
  };
}
