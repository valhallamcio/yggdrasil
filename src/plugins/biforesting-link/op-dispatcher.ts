import { eventBus } from '../../core/event-bus/index.js';
import { logger } from '../../core/logger/index.js';
import { encodeJsonPayload } from './decoders.js';
import { getPolicy, FEATURE_BITS } from './policy-store.js';
import type { OpsStore } from './ops-store.js';
import type { OpDoc, OpResMsg, PresenceMsg } from './types.js';

export const OP_CHANNEL = 'biforesting:op';
const CAP_OPS = FEATURE_BITS['ops']!;

/** How the dispatcher reaches a live link session (implemented by the link manager). */
export interface OpSendPort {
  /** True + written when a live writable session exists for the instanceKey. */
  sendDown(instanceKey: string, channel: string, payload: Buffer): boolean;
  /** instanceKeys of all live, identity-resolved sessions (for the sweep). */
  liveInstanceKeys(): string[];
}

/**
 * Drives `biforesting_ops` through its state machine: dispatches pending ops DOWN live links,
 * applies `op_res` acks/results, parks/wakes `waiting_player` ops on presence, and runs the
 * recovery sweep (dispatch/exec timeouts, expiry). At-least-once by design — the mod's opId
 * journal makes re-dispatch safe.
 *
 * Every state change emits `biforesting.op.updated` on the event bus (WS broadcast + VU).
 */
export class OpDispatcher {
  private sweepTimer: NodeJS.Timeout | null = null;
  private onUpdated: ((op: OpDoc) => Promise<void>) | null = null;

  constructor(
    private readonly store: OpsStore,
    private readonly port: OpSendPort,
    private readonly sweepIntervalMs = 15_000,
  ) {}

  /** Compound orchestration hook — fired (fire-and-forget) on every emitted op update. */
  setUpdateHook(hook: (op: OpDoc) => Promise<void>): void {
    this.onUpdated = hook;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.store.bootReset();
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((err) => logger.warn({ err }, 'biforesting-ops: sweep failed'));
    }, this.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  // ── Dispatch ───────────────────────────────────────────────────────────────

  /**
   * Push every dispatchable pending op for an instance DOWN its live link. Gated on the stored
   * policy's `ops` bit — the named rollback lever: with the bit off, ops queue durably but are
   * NEVER dispatched (no redeploy needed to stop the flow).
   */
  async dispatchPendingFor(instanceKey: string): Promise<number> {
    if (!(await this.opsEnabled(instanceKey))) return 0;
    const ops = await this.store.findDispatchable(instanceKey);
    let sent = 0;
    for (const op of ops) {
      if (await this.dispatchOne(op)) sent++;
    }
    return sent;
  }

  private async opsEnabled(instanceKey: string): Promise<boolean> {
    const policy = await getPolicy(instanceKey);
    return (policy.enabledFeatures & CAP_OPS) !== 0;
  }

  /**
   * Dispatch a single op: CAS pending→dispatched first, then write. If the write fails (link died
   * between the check and the write) the op is eagerly rolled back to `pending` — left as
   * `dispatched` it would ALSO miss the link-up redispatch (which only considers `pending`) and
   * sit until the sweep (observed live: op created while gtnh was down showed `dispatched`).
   */
  private async dispatchOne(op: OpDoc): Promise<boolean> {
    // Gate BEFORE the pending→dispatched CAS: with the ops bit off the op must stay `pending`
    // untouched (not burn attempts in a dispatch/timeout loop).
    if (!(await this.opsEnabled(op.instanceKey))) return false;
    const dispatched = await this.store.markDispatched(op._id);
    if (!dispatched) return false; // raced by cancel/expiry/another dispatch
    this.emitUpdated(dispatched);

    const wire = JSON.stringify({
      opId: dispatched._id,
      type: dispatched.type,
      params: dispatched.params,
      target: dispatched.target,
      flags: dispatched.flags,
      execTimeoutMs: dispatched.execTimeoutMs,
      expiresAt: dispatched.expiresAt.getTime(),
    });
    const ok = this.port.sendDown(dispatched.instanceKey, OP_CHANNEL, encodeJsonPayload(wire));
    if (!ok) {
      const requeued = await this.store.requeueUnwritable(dispatched._id);
      if (requeued) this.emitUpdated(requeued);
      logger.debug({ opId: op._id, instanceKey: op.instanceKey }, 'biforesting-ops: link gone mid-dispatch — eagerly requeued');
    }
    return ok;
  }

  /** Called by the link manager when a resolved backend registers (link-up). */
  async onLinkUp(instanceKey: string): Promise<void> {
    const sent = await this.dispatchPendingFor(instanceKey);
    if (sent > 0) logger.info({ instanceKey, sent }, 'biforesting-ops: dispatched queued ops on link-up');
  }

  /** Called by the REST controller right after creating an op. */
  async onOpCreated(op: OpDoc): Promise<void> {
    this.emitUpdated(op);
    await this.dispatchOne(op);
  }

  // ── Inbound (link manager routes op_res / presence here) ───────────────────

  async onOpRes(instanceKey: string, msg: OpResMsg): Promise<void> {
    const op = await this.store.get(msg.opId);
    if (!op) {
      logger.warn({ opId: msg.opId, instanceKey }, 'biforesting-ops: op_res for unknown op');
      return;
    }
    if (op.instanceKey !== instanceKey) {
      logger.warn(
        { opId: msg.opId, opInstance: op.instanceKey, fromInstance: instanceKey },
        'biforesting-ops: op_res from the wrong backend — ignored',
      );
      return;
    }

    let updated: OpDoc | null = null;
    if (msg.phase === 'ack') {
      updated = await this.store.markAcked(msg.opId);
    } else if (msg.status === 'completed') {
      updated = await this.store.markCompleted(msg.opId, {
        ok: true,
        data: msg.result ?? null,
        ...(msg.durationMs !== undefined ? { durationMs: msg.durationMs } : {}),
      });
    } else if (msg.status === 'failed') {
      updated = await this.store.markFailed(msg.opId, msg.error ?? 'backend reported failure', {
        ok: false,
        error: msg.error ?? 'backend reported failure',
        ...(msg.code !== undefined ? { code: msg.code } : {}),
        ...(msg.durationMs !== undefined ? { durationMs: msg.durationMs } : {}),
      });
    } else if (msg.status === 'waiting_player') {
      updated = await this.store.markWaitingPlayer(msg.opId);
    }
    if (updated) this.emitUpdated(updated);
  }

  async onPresence(instanceKey: string, msg: PresenceMsg): Promise<void> {
    eventBus.emit('biforesting.presence', { instanceKey, ...msg });

    const joined: Array<{ uuid: string; name: string }> =
      msg.event === 'join' && msg.player ? [msg.player] : msg.event === 'snapshot' && msg.online ? msg.online : [];

    for (const p of joined) {
      const waiting = await this.store.findWaitingForPlayer(instanceKey, p.uuid, p.name);
      for (const op of waiting) {
        const requeued = await this.store.requeueWaiting(op._id, `player ${p.name} joined`);
        if (requeued) {
          this.emitUpdated(requeued);
          await this.dispatchOne(requeued);
        }
      }
    }
  }

  // ── Recovery sweep ─────────────────────────────────────────────────────────

  async sweep(now: Date = new Date()): Promise<void> {
    for (const op of await this.store.findExpired(now)) {
      const updated = await this.store.markExpired(op._id);
      if (updated) this.emitUpdated(updated);
    }

    for (const op of await this.store.findStaleDispatched(now)) {
      const updated = await this.store.requeueOrFail(op);
      if (updated) this.emitUpdated(updated);
    }

    for (const op of await this.store.findStaleAcked(now)) {
      const updated = await this.store.markFailed(op._id, `no result within ${op.execTimeoutMs}ms of ack`);
      if (updated) this.emitUpdated(updated);
    }

    // Anything pending with a live link (requeued above, notBefore reached, missed link-up) goes out now.
    for (const instanceKey of this.port.liveInstanceKeys()) {
      await this.dispatchPendingFor(instanceKey);
    }
  }

  private emitUpdated(op: OpDoc): void {
    eventBus.emit('biforesting.op.updated', {
      opId: op._id,
      instanceKey: op.instanceKey,
      serverTag: op.serverTag,
      type: op.type,
      state: op.state,
      attempts: op.attempts,
      result: op.result,
      parentOpId: op.parentOpId,
      updatedAt: op.updatedAt,
    });
    if (this.onUpdated) {
      void this.onUpdated(op).catch((err) => logger.warn({ err, opId: op._id }, 'biforesting-ops: update hook failed'));
    }
  }
}
