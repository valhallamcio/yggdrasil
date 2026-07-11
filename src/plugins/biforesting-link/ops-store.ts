import type { Collection, Db } from 'mongodb';
import { logger } from '../../core/logger/index.js';
import { ulid } from './ulid.js';
import type { OpDoc, OpFlags, OpResult, OpState, OpTarget } from './types.js';

/**
 * Durable op store over `biforesting_ops` — the keystone of the v2 job API. Yggdrasil owns the
 * queue (at-least-once dispatch); the mod dedups via its opId journal, so the pair approximates
 * exactly-once. Every state transition is guarded by a `{_id, state: from}` filter (atomic — a
 * racing transition loses cleanly) and appends an audit entry.
 *
 *   pending → dispatched → acked → completed | failed
 *      ↑          │                    (op_res result)
 *      │          ├→ waiting_player  (target offline, queued for next login)
 *      │          └→ pending         (dispatch timeout, attempts < max)
 *      └── waiting_player (presence join re-queues)
 *   pending | waiting_player | dispatched → cancelled (REST, pre-ack only) | expired (sweep)
 *
 * Constructed with a Db provider (NEVER a captured Db — the Bifrost stale-client lesson) so tests
 * can point it at mem-mongo and prod at `getDb`.
 */

export interface CreateOpInput {
  instanceKey: string;
  serverTag: string | null;
  type: string;
  params: Record<string, unknown>;
  target?: OpTarget | null;
  flags?: OpFlags;
  idempotencyKey?: string;
  notBefore?: Date | null;
  expiresInMs?: number;
  maxAttempts?: number;
  dispatchTimeoutMs?: number;
  execTimeoutMs?: number;
  parentOpId?: string | null;
  childIndex?: number | null;
  createdBy: string;
}

export const OP_DEFAULTS = {
  maxAttempts: 5,
  dispatchTimeoutMs: 15_000,
  execTimeoutMs: 60_000,
  expiresInMs: 7 * 24 * 3600_000,
} as const;

/** States that may still reach the backend (cancellable, expirable). */
export const PRE_ACK_STATES: OpState[] = ['pending', 'dispatched', 'waiting_player'];

export class OpsStore {
  private indexEnsured = false;

  constructor(private readonly dbProvider: () => Db) {}

  private col(): Collection<OpDoc> {
    return this.dbProvider().collection<OpDoc>('biforesting_ops');
  }

  async ensureIndexes(): Promise<void> {
    if (this.indexEnsured) return;
    const col = this.col();
    await col.createIndex({ idempotencyKey: 1 }, { unique: true, sparse: true });
    await col.createIndex({ instanceKey: 1, state: 1 });
    await col.createIndex({ state: 1, expiresAt: 1 });
    this.indexEnsured = true;
  }

  // ── Create / read ──────────────────────────────────────────────────────────

  /** Insert a new op (state=pending). An idempotencyKey replay returns the EXISTING op. */
  async create(input: CreateOpInput): Promise<{ op: OpDoc; replayed: boolean }> {
    await this.ensureIndexes();
    const now = new Date();
    const doc: OpDoc = {
      _id: ulid(now.getTime()),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      instanceKey: input.instanceKey,
      serverTag: input.serverTag,
      type: input.type,
      params: input.params,
      target: input.target ?? null,
      flags: input.flags ?? {},
      state: 'pending',
      attempts: 0,
      maxAttempts: input.maxAttempts ?? OP_DEFAULTS.maxAttempts,
      dispatchTimeoutMs: input.dispatchTimeoutMs ?? OP_DEFAULTS.dispatchTimeoutMs,
      execTimeoutMs: input.execTimeoutMs ?? OP_DEFAULTS.execTimeoutMs,
      notBefore: input.notBefore ?? null,
      expiresAt: new Date(now.getTime() + (input.expiresInMs ?? OP_DEFAULTS.expiresInMs)),
      parentOpId: input.parentOpId ?? null,
      childIndex: input.childIndex ?? null,
      createdBy: input.createdBy,
      audit: [{ at: now, from: null, to: 'pending', note: `created by ${input.createdBy}` }],
      result: null,
      createdAt: now,
      updatedAt: now,
      dispatchedAt: null,
      ackedAt: null,
      completedAt: null,
    };
    try {
      await this.col().insertOne(doc);
      return { op: doc, replayed: false };
    } catch (err) {
      // Duplicate idempotencyKey → replay: return the existing op instead of a new one.
      if (input.idempotencyKey && (err as { code?: number }).code === 11000) {
        const existing = await this.col().findOne({ idempotencyKey: input.idempotencyKey });
        if (existing) return { op: existing, replayed: true };
      }
      throw err;
    }
  }

  async get(opId: string): Promise<OpDoc | null> {
    return this.col().findOne({ _id: opId });
  }

  async list(filter: { instanceKey?: string; state?: OpState; type?: string }, limit = 50): Promise<OpDoc[]> {
    const q: Record<string, unknown> = {};
    if (filter.instanceKey) q['instanceKey'] = filter.instanceKey;
    if (filter.state) q['state'] = filter.state;
    if (filter.type) q['type'] = filter.type;
    return this.col().find(q).sort({ _id: -1 }).limit(limit).toArray();
  }

  // ── Guarded transitions (single-doc CAS + audit) ───────────────────────────

  private async transition(
    opId: string,
    from: OpState | OpState[],
    to: OpState,
    extra: Partial<OpDoc>,
    note?: string,
  ): Promise<OpDoc | null> {
    const fromStates = Array.isArray(from) ? from : [from];
    // One CAS per candidate source state so the audit entry always carries the REAL `from`
    // (2-3 candidates max; a racing transition loses cleanly on every branch).
    for (const fromState of fromStates) {
      const now = new Date();
      const res = await this.col().findOneAndUpdate(
        { _id: opId, state: fromState },
        {
          $set: { ...extra, state: to, updatedAt: now },
          $push: { audit: { at: now, from: fromState, to, ...(note ? { note } : {}) } },
        },
        { returnDocument: 'after' },
      );
      if (res) return res;
    }
    return null;
  }

  /** pending → dispatched (attempts+1). Null when the op is no longer pending (racing sweep/cancel). */
  async markDispatched(opId: string): Promise<OpDoc | null> {
    const now = new Date();
    const res = await this.col().findOneAndUpdate(
      { _id: opId, state: 'pending' },
      {
        $set: { state: 'dispatched', dispatchedAt: now, updatedAt: now },
        $inc: { attempts: 1 },
        $push: { audit: { at: now, from: 'pending' as const, to: 'dispatched' as const } },
      },
      { returnDocument: 'after' },
    );
    return res ?? null;
  }

  async markAcked(opId: string): Promise<OpDoc | null> {
    return this.transition(opId, 'dispatched', 'acked', { ackedAt: new Date() });
  }

  /** Terminal result from op_res. Tolerates a result landing while still `dispatched` (ack lost). */
  async markCompleted(opId: string, result: OpResult): Promise<OpDoc | null> {
    return this.transition(opId, ['dispatched', 'acked'], 'completed', { result, completedAt: new Date() });
  }

  async markFailed(opId: string, error: string, result?: OpResult): Promise<OpDoc | null> {
    return this.transition(
      opId,
      ['pending', 'dispatched', 'acked', 'waiting_player'],
      'failed',
      { result: result ?? { ok: false, error }, completedAt: new Date() },
      error,
    );
  }

  /** Append a state-preserving audit note (e.g. a compound child skipped as unsupported). */
  async appendAudit(opId: string, note: string): Promise<void> {
    const now = new Date();
    const op = await this.get(opId);
    if (!op) return;
    await this.col().updateOne(
      { _id: opId },
      {
        $set: { updatedAt: now },
        $push: { audit: { at: now, from: op.state, to: op.state, note } },
      },
    );
  }

  /** Mod reported the target offline for a queue-mode op — parks until a presence join. */
  async markWaitingPlayer(opId: string): Promise<OpDoc | null> {
    return this.transition(opId, ['dispatched', 'acked'], 'waiting_player', {}, 'target offline — queued for next login');
  }

  /** waiting_player → pending (presence join re-queues for dispatch). */
  async requeueWaiting(opId: string, note: string): Promise<OpDoc | null> {
    return this.transition(opId, 'waiting_player', 'pending', {}, note);
  }

  /** Cancel — only before the backend acked (post-ack the op is executing; too late). */
  async cancel(opId: string, by: string): Promise<OpDoc | null> {
    return this.transition(opId, PRE_ACK_STATES, 'cancelled', { completedAt: new Date() }, `cancelled by ${by}`);
  }

  // ── Recovery / sweep queries ───────────────────────────────────────────────

  /**
   * Boot-reset: any op still `dispatched` when Yggdrasil starts was in flight when the previous
   * process died — its op_res (if any) is lost, so re-queue for dispatch (mod journal dedups).
   */
  async bootReset(): Promise<number> {
    await this.ensureIndexes();
    const now = new Date();
    const stale = await this.col().find({ state: 'dispatched' }).toArray();
    let n = 0;
    for (const op of stale) {
      const res = await this.transition(op._id, 'dispatched', 'pending', {}, 'boot-reset (yggdrasil restart)');
      if (res) n++;
    }
    if (n > 0) logger.info({ count: n, at: now }, 'biforesting-ops: boot-reset dispatched → pending');
    return n;
  }

  /** Ops ready for dispatch on an instance: pending, notBefore satisfied, not expired. Compound parents never dispatch. */
  async findDispatchable(instanceKey: string, now: Date = new Date()): Promise<OpDoc[]> {
    return this.col()
      .find({
        instanceKey,
        state: 'pending',
        'flags.compound': { $ne: true },
        expiresAt: { $gt: now },
        $or: [{ notBefore: null }, { notBefore: { $lte: now } }],
      })
      .sort({ _id: 1 })
      .toArray();
  }

  // ── Compound parents (account_reset — children carry the work) ─────────────

  /** All children of a compound parent, ordered by childIndex. */
  async childrenOf(parentOpId: string): Promise<OpDoc[]> {
    return this.col().find({ parentOpId }).sort({ childIndex: 1, _id: 1 }).toArray();
  }

  /** Compound parent success — parents live in `pending` while children run. */
  async completeCompound(opId: string, result: OpResult): Promise<OpDoc | null> {
    return this.transition(opId, 'pending', 'completed', { result, completedAt: new Date() }, 'all children completed');
  }

  /** failed → pending for /resume (a fresh child is spawned for the first incomplete step). */
  async reopenCompound(opId: string): Promise<OpDoc | null> {
    return this.transition(opId, 'failed', 'pending', { completedAt: null }, 'resumed');
  }

  /** `dispatched` ops whose ack never came back within dispatchTimeoutMs. */
  async findStaleDispatched(now: Date = new Date()): Promise<OpDoc[]> {
    const candidates = await this.col().find({ state: 'dispatched' }).toArray();
    return candidates.filter(
      (op) => op.dispatchedAt !== null && now.getTime() - op.dispatchedAt.getTime() > op.dispatchTimeoutMs,
    );
  }

  /** `acked` ops whose result never came back within execTimeoutMs. */
  async findStaleAcked(now: Date = new Date()): Promise<OpDoc[]> {
    const candidates = await this.col().find({ state: 'acked' }).toArray();
    return candidates.filter(
      (op) => op.ackedAt !== null && now.getTime() - op.ackedAt.getTime() > op.execTimeoutMs,
    );
  }

  /** Ops past expiresAt that can still be expired (never completed/failed/cancelled). */
  async findExpired(now: Date = new Date()): Promise<OpDoc[]> {
    return this.col()
      .find({ state: { $in: PRE_ACK_STATES }, expiresAt: { $lte: now } })
      .toArray();
  }

  /** Eager rollback when the link write failed right after the pending→dispatched CAS. */
  async requeueUnwritable(opId: string): Promise<OpDoc | null> {
    return this.transition(opId, 'dispatched', 'pending', {}, 'link not writable at dispatch — eager requeue');
  }

  /** Requeue a timed-out dispatch, or fail it once attempts are exhausted. */
  async requeueOrFail(op: OpDoc): Promise<OpDoc | null> {
    if (op.attempts >= op.maxAttempts) {
      return this.markFailed(op._id, `no ack after ${op.attempts} dispatch attempts`);
    }
    return this.transition(op._id, 'dispatched', 'pending', {}, `dispatch timeout (attempt ${op.attempts})`);
  }

  async markExpired(opId: string): Promise<OpDoc | null> {
    return this.transition(opId, PRE_ACK_STATES, 'expired', { completedAt: new Date() }, 'expiresAt passed');
  }

  /** waiting_player ops for a player who just joined (matched by uuid or name, case-insensitive). */
  async findWaitingForPlayer(instanceKey: string, uuid: string, name: string): Promise<OpDoc[]> {
    const ops = await this.col().find({ instanceKey, state: 'waiting_player' }).toArray();
    const lower = name.toLowerCase();
    return ops.filter(
      (op) => op.target !== null && (op.target.uuid === uuid || op.target.name?.toLowerCase() === lower),
    );
  }
}
