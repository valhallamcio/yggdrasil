import type { Collection, Db, Filter } from 'mongodb';

/**
 * Quest party merges in `biforesting_sync_quest_merges` (valhallamc-work
 * evol-multi-instance-2026-10/phase6/DESIGN.md 4 and 7): one doc per (source party, target
 * party). A party owner merges a pair once. A failed merge may run again. A doc stays `running`
 * while its import op can still run on the target instance.
 */

export const QUEST_MERGE_STATES = ['running', 'done', 'failed'] as const;
export type QuestMergeState = (typeof QUEST_MERGE_STATES)[number];

export interface SyncQuestMergeDoc {
  /** See {@link questMergeId}. */
  _id: string;
  group: string;
  /** The player who ran the merge (the target party owner), lowercase. */
  uuid: string;
  name: string;
  sourceServerId: string;
  /** Lowercase. */
  sourceTeamId: string;
  targetServerId: string;
  /** Lowercase. */
  targetTeamId: string;
  state: QuestMergeState;
  /** The quest lock holder of the attempt. Only that attempt writes the doc. */
  runId: string;
  attempts: number;
  exportOpId: string | null;
  importOpId: string | null;
  /** The local backup the target instance took before the import. */
  backupId: string | null;
  code: string | null;
  error: string | null;
  actor: string;
  startedAt: Date;
  updatedAt: Date;
  endedAt: Date | null;
}

export interface QuestMergeStart {
  group: string;
  uuid: string;
  name: string;
  sourceServerId: string;
  sourceTeamId: string;
  targetServerId: string;
  targetTeamId: string;
  runId: string;
  actor: string;
}

/** `<group>:<sourceServerId>:<sourceTeamId>:<targetServerId>:<targetTeamId>`, team ids lowercase. */
export function questMergeId(group: string, sourceServerId: string, sourceTeamId: string, targetServerId: string, targetTeamId: string): string {
  return `${group}:${sourceServerId}:${sourceTeamId.toLowerCase()}:${targetServerId}:${targetTeamId.toLowerCase()}`;
}

type MergeSet = Partial<Pick<SyncQuestMergeDoc, 'state' | 'exportOpId' | 'importOpId' | 'backupId' | 'code' | 'error' | 'endedAt'>>;

export class SyncQuestMergesStore {
  private indexEnsured = false;

  constructor(
    private readonly dbProvider: () => Db,
    private readonly now: () => number = Date.now,
  ) {}

  private col(): Collection<SyncQuestMergeDoc> {
    return this.dbProvider().collection<SyncQuestMergeDoc>('biforesting_sync_quest_merges');
  }

  async ensureIndexes(): Promise<void> {
    if (this.indexEnsured) return;
    await this.col().createIndex({ group: 1, sourceServerId: 1, sourceTeamId: 1 });
    await this.col().createIndex({ group: 1, uuid: 1, startedAt: -1 });
    this.indexEnsured = true;
  }

  async get(id: string): Promise<SyncQuestMergeDoc | null> {
    return this.col().findOne({ _id: id });
  }

  /** Inserts a `running` doc for the first attempt. Null when a doc of this pair exists. */
  async insertRunning(input: QuestMergeStart): Promise<SyncQuestMergeDoc | null> {
    await this.ensureIndexes();
    const now = new Date(this.now());
    const doc: SyncQuestMergeDoc = {
      _id: questMergeId(input.group, input.sourceServerId, input.sourceTeamId, input.targetServerId, input.targetTeamId),
      ...input,
      sourceTeamId: input.sourceTeamId.toLowerCase(),
      targetTeamId: input.targetTeamId.toLowerCase(),
      state: 'running',
      attempts: 1,
      exportOpId: null,
      importOpId: null,
      backupId: null,
      code: null,
      error: null,
      startedAt: now,
      updatedAt: now,
      endedAt: null,
    };
    try {
      await this.col().insertOne(doc);
      return doc;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return null;
      throw err;
    }
  }

  /** Starts a new attempt on a `failed` doc. Null when the doc is not `failed` any more. */
  async restart(id: string, input: Pick<QuestMergeStart, 'uuid' | 'name' | 'runId' | 'actor'>): Promise<SyncQuestMergeDoc | null> {
    const now = new Date(this.now());
    return this.col().findOneAndUpdate(
      { _id: id, state: 'failed' },
      {
        $set: { ...input, state: 'running', exportOpId: null, importOpId: null, backupId: null, code: null, error: null, startedAt: now, updatedAt: now, endedAt: null },
        $inc: { attempts: 1 },
      },
      { returnDocument: 'after' },
    );
  }

  /** Writes fields of the attempt `runId`. Null when another attempt holds the doc. */
  async update(id: string, runId: string, set: MergeSet): Promise<SyncQuestMergeDoc | null> {
    return this.col().findOneAndUpdate({ _id: id, runId }, { $set: { ...set, updatedAt: new Date(this.now()) } }, { returnDocument: 'after' });
  }

  /** `done` merges out of these source parties, for the candidate list. */
  async listDoneFrom(group: string, sources: Array<{ serverId: string; teamId: string }>): Promise<SyncQuestMergeDoc[]> {
    if (sources.length === 0) return [];
    await this.ensureIndexes();
    const q: Filter<SyncQuestMergeDoc> = {
      group,
      state: 'done',
      $or: sources.map((s) => ({ sourceServerId: s.serverId, sourceTeamId: s.teamId.toLowerCase() })),
    };
    return this.col().find(q).sort({ endedAt: 1 }).toArray();
  }
}
