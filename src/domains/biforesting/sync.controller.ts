import type { Request, Response } from 'express';
import { logger } from '../../core/logger/index.js';
import { syncGroupsStore, syncLedgerStore, syncQuests, syncRunner, syncService, syncSnapshotStore } from '../../plugins/biforesting-link/sync-runtime.js';
import { groupView } from '../../plugins/biforesting-link/sync-service.js';
import { NotFoundError } from '../../shared/errors/index.js';
import { binaryToBuffer } from './biforesting.controller.js';
import type {
  ShadowMoveBody,
  SyncForceReleaseBody,
  SyncGroupParams,
  SyncGroupPutBody,
  SyncMoveListQuery,
  SyncMoveParams,
  SyncMoveStartBody,
  SyncMoveWaitQuery,
  SyncPlayerParams,
  SyncQuestActionBody,
  SyncQuestMergeBody,
  SyncReseedBody,
  SyncSnapshotIdParams,
  SyncSnapshotListQuery,
} from './sync.schema.js';

function actorOf(req: Request): string {
  return (req.headers['x-actor'] as string | undefined) ?? 'api';
}

/** Player sync REST (bifrost-lib `docs/invariants/player-sync.md` section 7). */
export class SyncController {
  /** The group doc, its members with link facts, and ledger counts by state. */
  getGroup = async (req: Request, res: Response): Promise<void> => {
    const { group } = req.params as unknown as SyncGroupParams;
    res.json({ data: await syncService.groupStatus(group) });
  };

  /** A mode change into or out of `live` also starts disown reconcile or stops open moves (spec 6.6). */
  putGroup = async (req: Request, res: Response): Promise<void> => {
    const { group } = req.params as unknown as SyncGroupParams;
    const body = req.body as SyncGroupPutBody;
    const before = await syncGroupsStore.get(group);
    const doc = await syncGroupsStore.upsert(group, body, actorOf(req));
    try {
      await syncRunner.onGroupUpdated(group, before, { ...before, ...doc });
    } catch (err) {
      logger.warn({ err, group, from: before.mode, to: doc.mode }, 'biforesting-sync: group mode change work failed; the sweep and the next register retry it');
    }
    res.json({ data: groupView(doc) });
  };

  /** After a restore of `serverId` (spec 6.7): 409 `not_frozen` or `not_member`, else the reseed result. */
  postReseed = async (req: Request, res: Response): Promise<void> => {
    const { group } = req.params as unknown as SyncGroupParams;
    const { serverId } = req.body as SyncReseedBody;
    res.json({ data: await syncRunner.reseed(group, serverId, actorOf(req)) });
  };

  /** 201 at step prepare, or 409 with a sync code and a player-facing message. */
  postMove = async (req: Request, res: Response): Promise<void> => {
    const { group, uuid } = req.params as unknown as SyncPlayerParams;
    const body = req.body as SyncMoveStartBody;
    const move = await syncRunner.startMove(group, uuid, { ...body, actor: actorOf(req) });
    res.status(201).json({ data: { move } });
  };

  /** One move, as a long poll when `waitMs` is set. A client that leaves ends the wait. */
  getMove = async (req: Request, res: Response): Promise<void> => {
    const { group, uuid, moveId } = req.params as unknown as SyncMoveParams;
    const { waitMs, step } = req.query as unknown as SyncMoveWaitQuery;
    const gone = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) gone.abort();
    });
    const move = await syncRunner.waitMove(group, uuid, moveId, waitMs, step, gone.signal);
    if (gone.signal.aborted) return;
    res.json({ data: move });
  };

  listMoves = async (req: Request, res: Response): Promise<void> => {
    const { group, uuid } = req.params as unknown as SyncPlayerParams;
    const { limit } = req.query as unknown as SyncMoveListQuery;
    const moves = await syncRunner.listMoves(group, uuid, limit);
    res.json({ data: { group, uuid, count: moves.length, moves } });
  };

  cancelMove = async (req: Request, res: Response): Promise<void> => {
    const { group, uuid, moveId } = req.params as unknown as SyncMoveParams;
    res.json({ data: await syncRunner.cancelMove(group, uuid, moveId, actorOf(req)) });
  };

  /** Staff: apply a snapshot on `to` and make it the owner (spec 6.3). */
  forceRelease = async (req: Request, res: Response): Promise<void> => {
    const { group, uuid } = req.params as unknown as SyncPlayerParams;
    const body = req.body as SyncForceReleaseBody;
    res.status(201).json({ data: await syncRunner.forceRelease(group, uuid, body, actorOf(req)) });
  };

  getPlayer = async (req: Request, res: Response): Promise<void> => {
    const { group, uuid } = req.params as unknown as SyncPlayerParams;
    const doc = await syncLedgerStore.get(group, uuid);
    if (!doc) throw new NotFoundError('Sync player', `${group}:${uuid}`);
    const { move } = doc;
    res.json({
      data: {
        group: doc.group,
        uuid: doc.uuid,
        name: doc.name,
        owner: doc.owner,
        version: doc.version,
        state: doc.state,
        move: move ? { id: move.id, from: move.from, to: move.to, step: move.step, startedAt: move.startedAt } : null,
        lastSeen: doc.lastSeen,
        shadow: doc.shadow,
        disowned: doc.disowned ?? [],
        trustDisk: doc.trustDisk === true,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      },
    });
  };

  /** Dry run of a move: stores and returns the verdict, moves nothing. */
  postShadowMove = async (req: Request, res: Response): Promise<void> => {
    const { group, uuid } = req.params as unknown as SyncPlayerParams;
    const { from, to } = req.body as ShadowMoveBody;
    res.json({ data: await syncService.shadowMove(group, uuid, from, to) });
  };

  listSnapshots = async (req: Request, res: Response): Promise<void> => {
    const { group, uuid } = req.params as unknown as SyncPlayerParams;
    const { kind } = req.query as unknown as SyncSnapshotListQuery;
    const snapshots = await syncSnapshotStore.list(group, uuid, kind);
    res.json({ data: { group, uuid, count: snapshots.length, snapshots } });
  };

  // ── Quest progress (phase6 DESIGN 4 and 7) ─────────────────────────────────

  /** `quests_status` on the owner instance. */
  getQuests = async (req: Request, res: Response): Promise<void> => {
    const { group, uuid } = req.params as unknown as SyncPlayerParams;
    res.json({ data: await syncQuests.status(group, uuid, actorOf(req)) });
  };

  /** One `/quests` menu action on the owner instance. 409 `moving` during a move. */
  postQuestAction = async (req: Request, res: Response): Promise<void> => {
    const { group, uuid } = req.params as unknown as SyncPlayerParams;
    const body = req.body as SyncQuestActionBody;
    res.json({ data: await syncQuests.action(group, uuid, body, actorOf(req)) });
  };

  /** The parties on the other instances that hold the player. Partial when a member is down. */
  getQuestCandidates = async (req: Request, res: Response): Promise<void> => {
    const { group, uuid } = req.params as unknown as SyncPlayerParams;
    res.json({ data: await syncQuests.partyCandidates(group, uuid, actorOf(req)) });
  };

  /** Export a party from `fromServer`, import it on the owner instance. One merge per pair. */
  postQuestMerge = async (req: Request, res: Response): Promise<void> => {
    const { group, uuid } = req.params as unknown as SyncPlayerParams;
    const body = req.body as SyncQuestMergeBody;
    res.json({ data: await syncQuests.partyMerge(group, uuid, body, actorOf(req)) });
  };

  /** One snapshot with its gz blob as base64. */
  getSnapshot = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as unknown as SyncSnapshotIdParams;
    const snap = await syncSnapshotStore.get(id);
    if (!snap) throw new NotFoundError('Sync snapshot', id);
    const { gz, ...rest } = snap;
    res.json({ data: { ...rest, gzBase64: binaryToBuffer(gz)?.toString('base64') ?? null } });
  };
}
