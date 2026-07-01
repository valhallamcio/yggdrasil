import type { Request, Response } from 'express';
import { biforestingLinkManager } from '../../plugins/biforesting-link/link-manager.js';
import { encodeQuestDown, encodeChunksDown } from '../../plugins/biforesting-link/decoders.js';
import { getPolicy, setPolicy, maskForFeatures, featureNamesForMask } from '../../plugins/biforesting-link/policy-store.js';
import { serverResolver } from '../../plugins/biforesting-link/server-resolver.js';
import { NotFoundError, ValidationError } from '../../shared/errors/index.js';
import type { LinkServerParams, PolicyPutBody, QuestDownBody, ChunksDownBody } from './biforesting.schema.js';

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
