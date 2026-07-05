import { eventBus } from '../../core/event-bus/index.js';
import { logger } from '../../core/logger/index.js';
import type { OpDispatcher } from './op-dispatcher.js';
import type { OpsStore } from './ops-store.js';
import type { OpDoc } from './types.js';

/**
 * Compound-op orchestration (phase 7): a parent op (flags.compound — never wire-dispatched)
 * expands into ordered children; child N+1 is created+dispatched only after N completes. A child
 * failure/expiry/cancel fails the parent AT THE CHECKPOINT (completed children stay done);
 * `POST /ops/:opId/resume` reopens the parent and spawns a fresh child for the first incomplete
 * step. A `waiting_player` child just stalls the chain (presence join resumes it, D5).
 *
 * Single-instance in-process advance (plan R5) — the dispatcher calls {@link onChildUpdate} on
 * every op update it emits.
 */

export interface ChildSpec {
  type: string;
  params: Record<string, unknown>;
}

/**
 * account_reset children, in checkpoint order (D15: claims default to TRANSFER to the
 * server-owned hold team; `claims:'release'` opts out). The inventory snapshot runs FIRST —
 * the restore point before anything destructive.
 */
export function accountResetChildren(params: Record<string, unknown>): ChildSpec[] {
  const holdTeam = typeof params['holdTeam'] === 'string' ? params['holdTeam'] : 'valhallamc';
  const claims: ChildSpec =
    params['claims'] === 'release'
      ? { type: 'claims_release', params: {} }
      : { type: 'claims_transfer', params: { holdTeam } };
  return [
    { type: 'inspect_inventory', params: {} },
    { type: 'quest_reset', params: {} }, // no questId = reset ALL
    claims,
    { type: 'team_reset', params: {} },
    { type: 'inventory_clear', params: {} },
  ];
}

export const COMPOUND_TYPES: Record<string, (params: Record<string, unknown>) => ChildSpec[]> = {
  account_reset: accountResetChildren,
};

/** Child states that count as "this step needs no new attempt". */
const CHILD_SETTLED_OR_RUNNING = ['pending', 'dispatched', 'acked', 'waiting_player', 'completed'];

export class CompoundOps {
  constructor(
    private readonly store: OpsStore,
    private readonly dispatcher: OpDispatcher,
  ) {}

  /** Called by the REST controller right after creating a compound parent. */
  async expand(parent: OpDoc): Promise<void> {
    await this.spawnChild(parent, 0);
  }

  /** Dispatcher hook — fires on EVERY op update; non-children and non-terminal states no-op. */
  async onChildUpdate(op: OpDoc): Promise<void> {
    if (!op.parentOpId || op.childIndex === null || op.childIndex === undefined) return;
    try {
      if (op.state === 'completed') {
        await this.advance(op.parentOpId);
      } else if (op.state === 'failed' || op.state === 'expired' || op.state === 'cancelled') {
        const parent = await this.store.get(op.parentOpId);
        if (!parent || parent.state !== 'pending') return;
        const failed = await this.store.markFailed(
          parent._id,
          `child ${op.childIndex} (${op.type}) ${op.state}: ${(op.result as { error?: string } | null)?.error ?? ''}`,
          { ok: false, error: `checkpoint at child ${op.childIndex} (${op.type})`, data: await this.childSummary(parent._id) },
        );
        if (failed) this.emit(failed);
      }
    } catch (err) {
      logger.warn({ err, parentOpId: op.parentOpId, childIndex: op.childIndex }, 'biforesting-compound: advance failed');
    }
  }

  /** POST /ops/:opId/resume — reopen a failed parent, respawn the first incomplete child. */
  async resume(parentOpId: string): Promise<OpDoc | null> {
    const parent = await this.store.get(parentOpId);
    if (!parent || parent.flags?.compound !== true) return null;
    if (parent.state !== 'failed') return null;
    const reopened = await this.store.reopenCompound(parentOpId);
    if (!reopened) return null;
    this.emit(reopened);
    await this.advance(parentOpId);
    return this.store.get(parentOpId);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Scan the whole chain: skip completed steps, wait on a running/parked one, spawn the first gap. */
  private async advance(parentOpId: string): Promise<void> {
    const parent = await this.store.get(parentOpId);
    if (!parent || parent.state !== 'pending') return;
    const specs = this.specsFor(parent);
    if (!specs) return;
    const children = await this.store.childrenOf(parentOpId);

    for (let i = 0; i < specs.length; i++) {
      const forIndex = children.filter((c) => c.childIndex === i);
      const settled = forIndex.some((c) => CHILD_SETTLED_OR_RUNNING.includes(c.state));
      const done = forIndex.some((c) => c.state === 'completed');
      if (done) continue; // step already succeeded — next
      if (settled) return; // running/parked — the chain waits for it
      await this.spawnChild(parent, i);
      return; // one live child at a time — its completion advances the chain
    }

    // every spec index has a completed child → parent success
    const completed = await this.store.completeCompound(parentOpId, {
      ok: true,
      data: await this.childSummary(parentOpId),
    });
    if (completed) this.emit(completed);
  }

  private async spawnChild(parent: OpDoc, index: number): Promise<void> {
    const specs = this.specsFor(parent);
    if (!specs || index >= specs.length) return;
    const spec = specs[index]!;
    const { op } = await this.store.create({
      instanceKey: parent.instanceKey,
      serverTag: parent.serverTag,
      type: spec.type,
      params: spec.params,
      target: parent.target,
      parentOpId: parent._id,
      childIndex: index,
      expiresInMs: Math.max(60_000, parent.expiresAt.getTime() - Date.now()),
      createdBy: `${parent.createdBy} (${parent.type} child ${index})`,
    });
    logger.info(
      { parentOpId: parent._id, childOpId: op._id, childIndex: index, type: spec.type },
      'biforesting-compound: child spawned',
    );
    await this.dispatcher.onOpCreated(op);
  }

  private specsFor(parent: OpDoc): ChildSpec[] | null {
    const factory = COMPOUND_TYPES[parent.type];
    return factory ? factory(parent.params) : null;
  }

  private async childSummary(parentOpId: string): Promise<{ children: Array<{ opId: string; childIndex: number | null; type: string; state: string; result: unknown }> }> {
    const children = await this.store.childrenOf(parentOpId);
    return {
      children: children.map((c) => ({ opId: c._id, childIndex: c.childIndex ?? null, type: c.type, state: c.state, result: c.result })),
    };
  }

  private emit(op: OpDoc): void {
    eventBus.emit('biforesting.op.updated', {
      opId: op._id,
      instanceKey: op.instanceKey,
      serverTag: op.serverTag,
      type: op.type,
      state: op.state,
      attempts: op.attempts,
      result: op.result,
      parentOpId: op.parentOpId ?? null,
      updatedAt: op.updatedAt,
    });
  }
}
