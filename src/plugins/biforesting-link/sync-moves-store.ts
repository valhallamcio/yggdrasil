import type { Collection, Db, UpdateFilter } from 'mongodb';
import type { SyncMoveRef, SyncPlayerState } from './sync-ledger-store.js';
import type { SyncBlockedEntry } from './types.js';

/**
 * Player sync moves in `biforesting_sync_moves` (bifrost-lib `docs/invariants/player-sync.md`
 * sections 5 and 6): one doc per move. It is the audit trail and the runner's own state: the op
 * of each step, retry counts, the probe in flight and the cancel request. The ledger doc holds
 * the owner and the version; this doc holds how the move got there.
 */

/** `disown` is the force-release gate before its apply (spec 6.3). A player move never takes it. */
export const MOVE_STEPS = ['prepare', 'wait_quit', 'release', 'disown', 'apply', 'commit', 'abort', 'done'] as const;
export type MoveStep = (typeof MOVE_STEPS)[number];

/** Steps while the ledger doc still names the move (state `moving` or `applying`). */
export const LEDGER_STEPS: readonly MoveStep[] = ['prepare', 'wait_quit', 'release', 'disown', 'apply'];
/** Every step except `done`. */
export const OPEN_STEPS: readonly MoveStep[] = ['prepare', 'wait_quit', 'release', 'disown', 'apply', 'commit', 'abort'];

export type MoveOutcome = 'committed' | 'aborted' | 'stuck' | 'cancelled';

/** The `code` of a move that did not commit (spec 6.1). */
export const MOVE_CODES = ['blocked', 'fingerprint_mismatch', 'timeout', 'player_online', 'cancelled', 'error'] as const;
export type MoveCode = (typeof MOVE_CODES)[number];

export type MoveKind = 'move' | 'force_release';

export interface MoveStepRecord {
  step: string;
  at: Date;
  opId?: string;
  status: string;
  code?: string;
  detail?: string;
}

export interface SyncMoveOps {
  prepare?: string | null;
  release?: string | null;
  apply?: string | null;
  /** The `sync_apply` again at step commit, after a probe proved the apply. */
  reapply?: string | null;
  commit?: string | null;
  abort?: string | null;
  probe: string[];
  /** The `sync_probe` to the target at move start. Its answer sets `targetHasCharacter`. */
  targetProbe?: string | null;
}

/** Ops created per step. The idempotency key suffix of the next op of a step is this count. */
export interface SyncMoveAttempts {
  release: number;
  apply: number;
  reapply: number;
  commit: number;
  abort: number;
  probe: number;
}

/**
 * Ops of the final steps that failed with no verdict from the mod: no link, the player_sync bit
 * off, or sync inert on the mod. They do not count against the retry limit.
 */
export interface SyncMoveUncounted {
  reapply: number;
  commit: number;
  abort: number;
}

/** One instance in the force-release gate: it gets a `sync_kick` and a one-entry `sync_disown`. */
export interface SyncGateEntry {
  serverId: string;
  kick: string | null;
  disown: string | null;
  /** `sync_disown` ops created for this instance. */
  attempts: number;
  uncounted: number;
  /** The disown completed, or it stays queued for a dead member of a stuck ledger. */
  done: boolean;
}

/** A `sync_probe` in flight. It answers for the step op `after` only. */
export interface SyncMoveProbe {
  opId: string;
  /** The probed instance. */
  on: string;
  for: 'release' | 'apply';
  /** The step op the probe is about. */
  after: string;
  at: Date;
}

export interface SyncMoveCancel {
  by: string;
  /**
   * `staff`: REST cancel (spec 6.3). `mode_off`: the group left live mode (spec 6.6). `reseed`:
   * a reseed of an instance the move touches (spec 6.7).
   */
  reason: 'staff' | 'mode_off' | 'reseed';
  /** `reseed` only: the reseeded instance. */
  serverId?: string;
  at: Date;
}

/** The ledger as it was before a force-release, so an abort can put it back. */
export interface SyncLedgerBefore {
  state: SyncPlayerState;
  owner: string | null;
  version: number;
  move: SyncMoveRef | null;
}

export interface SyncMoveDoc {
  /** ULID. */
  _id: string;
  group: string;
  /** Lowercase. */
  uuid: string;
  name: string;
  kind: MoveKind;
  /** The source instance. A force-release names the old owner, or null when there was none. */
  from: string | null;
  to: string;
  vFrom: number;
  vTo: number;
  actor: string;
  reason: string | null;
  step: MoveStep;
  outcome: MoveOutcome | null;
  code: MoveCode | null;
  ops: SyncMoveOps;
  attempts: SyncMoveAttempts;
  uncounted: SyncMoveUncounted;
  snapshotId: string | null;
  sha256: string | null;
  /** Fingerprint of the release blob. */
  fp: string | null;
  blocked: SyncBlockedEntry[];
  /** World-data records that travel with this move (S3). */
  worldData: Array<{ h: string; key: string }>;
  error: { code: string; message: string } | null;
  steps: MoveStepRecord[];
  /** A release of this move completed, so the source stamp reads `vTo`. */
  released: boolean;
  /**
   * The runner moved on from an apply attempt with an unknown outcome (`handler_failed`, no
   * result). The target may hold part of it, so the move commits or goes stuck after that. Only a
   * staff cancel can still abort it, after a probe of the target found no stamp and no apply op
   * of the move can still run.
   */
  applyUncertain: boolean;
  /**
   * A probe proved the apply, but the apply op never completed. The target may still hold an old
   * `away` or `moving` mark, so step commit sends the `sync_apply` once more first.
   */
  needsReapply: boolean;
  /** The ledger write of the outcome is done. Only meaningful at steps commit, abort and done. */
  ledgerDone: boolean;
  /** `prepare` result: the player was online on the source. Null before the result. */
  prepareOnline: boolean | null;
  /**
   * The target probe at move start found a `.dat` of the player on the target (`datExists`).
   * Null until it answers, when it fails, and on a force-release. It never gates the move.
   */
  targetHasCharacter: boolean | null;
  /** At step wait_quit: a quit on the source after this time starts the release. */
  quitAfter: Date;
  /** At step wait_quit: the release starts at this time without a quit. */
  releaseAt: Date | null;
  waitQuitRetried: boolean;
  probe: SyncMoveProbe | null;
  cancel: SyncMoveCancel | null;
  /** Force-release only. */
  before: SyncLedgerBefore | null;
  /** Force-release only: instances that may hold a copy. They get a kick and a disown before the apply. */
  disownTo: string[];
  /** Force-release only: the gate state per instance of {@link disownTo}. */
  gate: SyncGateEntry[];
  startedAt: Date;
  updatedAt: Date;
  endedAt: Date | null;
  /** Deadline of the current step. */
  deadlineAt: Date;
}

export class SyncMovesStore {
  private indexEnsured = false;

  constructor(
    private readonly dbProvider: () => Db,
    private readonly now: () => number = Date.now,
  ) {}

  private col(): Collection<SyncMoveDoc> {
    return this.dbProvider().collection<SyncMoveDoc>('biforesting_sync_moves');
  }

  async ensureIndexes(): Promise<void> {
    if (this.indexEnsured) return;
    const col = this.col();
    await col.createIndex({ group: 1, uuid: 1, startedAt: -1 });
    await col.createIndex({ outcome: 1, deadlineAt: 1 });
    await col.createIndex({ step: 1 });
    this.indexEnsured = true;
  }

  async insert(doc: SyncMoveDoc): Promise<void> {
    await this.ensureIndexes();
    await this.col().insertOne(doc);
  }

  async get(id: string): Promise<SyncMoveDoc | null> {
    return this.col().findOne({ _id: id });
  }

  /** Removes a move doc whose start lost the ledger race. */
  async delete(id: string): Promise<void> {
    await this.col().deleteOne({ _id: id });
  }

  /**
   * One guarded write: it applies only while the move is still at `step`. Returns the doc after
   * the write, or null when the step changed. `updatedAt` is always set.
   */
  async update(id: string, step: MoveStep, update: UpdateFilter<SyncMoveDoc>): Promise<SyncMoveDoc | null> {
    const withStamp: UpdateFilter<SyncMoveDoc> = { ...update, $set: { ...update.$set, updatedAt: new Date(this.now()) } };
    return this.col().findOneAndUpdate({ _id: id, step }, withStamp, { returnDocument: 'after' });
  }

  /**
   * Sets the cancel request of a move with no outcome yet. False when it has an outcome or a
   * cancel request already. A `reseed` request replaces a staff or mode request: its rule for an
   * apply that went out is stricter.
   */
  async requestCancel(id: string, cancel: SyncMoveCancel): Promise<boolean> {
    const guard = cancel.reason === 'reseed' ? { 'cancel.reason': { $ne: 'reseed' } } : { cancel: null };
    const res = await this.col().updateOne(
      { _id: id, outcome: null, ...guard },
      { $set: { cancel, updatedAt: new Date(this.now()) } },
    );
    return res.modifiedCount === 1;
  }

  /**
   * Stores the answer of the target probe, at any step and after the end too. Returns the doc
   * after the write, or null when the move is gone or already holds this answer.
   */
  async setTargetHasCharacter(id: string, opId: string, value: boolean, record: MoveStepRecord): Promise<SyncMoveDoc | null> {
    return this.col().findOneAndUpdate(
      { _id: id, targetHasCharacter: { $ne: value } },
      { $set: { targetHasCharacter: value, 'ops.targetProbe': opId, updatedAt: new Date(this.now()) }, $push: { steps: record } },
      { returnDocument: 'after' },
    );
  }

  /** Moves that are not done yet, oldest first. */
  async listOpen(limit = 1000): Promise<SyncMoveDoc[]> {
    return this.col()
      .find({ step: { $in: [...OPEN_STEPS] } })
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
  }

  /** The newest committed player move (force-releases excluded) of one player. */
  async latestCommitted(group: string, uuid: string): Promise<SyncMoveDoc | null> {
    return this.col()
      .find({ group, uuid: uuid.toLowerCase(), outcome: 'committed', kind: 'move' })
      .sort({ startedAt: -1 })
      .limit(1)
      .next();
  }

  /** Newest-first moves of one player. */
  async listForPlayer(group: string, uuid: string, limit: number): Promise<SyncMoveDoc[]> {
    return this.col()
      .find({ group, uuid: uuid.toLowerCase() })
      .sort({ startedAt: -1 })
      .limit(limit)
      .toArray();
  }
}
