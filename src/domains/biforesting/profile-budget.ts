import type { OpState } from '../../plugins/biforesting-link/types.js';

/**
 * Prod capture budget (profiler plan, "Prod capture budget"). Tier B runs without asking: level
 * l0 or l1, at most 60 s, at most one capture per server per 30 min. Everything else is tier C
 * and needs `confirm: true`. The mod enforces the same limits again.
 */
export const PROFILE_BUDGET = {
  levels: ['l0', 'l1'] as readonly string[],
  maxSeconds: 60,
  windowMs: 30 * 60_000,
};

/** Captures in these states count against the 30 min window. Failed ones did not run to the end. */
export const PROFILE_COUNTED_STATES: OpState[] = ['pending', 'dispatched', 'acked', 'waiting_player', 'completed'];

/** Time after the capture ends for the report build and the op result. */
export const PROFILE_EXEC_MARGIN_MS = 120_000;
/** A capture that waits longer than this for its server expires and never runs. */
export const PROFILE_OP_EXPIRES_MS = 30 * 60_000;

/** A profile_fetch uploads files that already exist. Large traces over a slow uplink get this long. */
export const PROFILE_FETCH_EXEC_TIMEOUT_MS = 5 * 60_000;

export function profileCaptureExecTimeoutMs(seconds: number): number {
  return seconds * 1000 + PROFILE_EXEC_MARGIN_MS;
}

/** Null when the capture fits tier B, else the reason it needs `confirm: true`. */
export function profileBudgetError(
  req: { seconds: number; level: string },
  lastCaptureAt: Date | null,
  now: number = Date.now(),
): string | null {
  const reasons: string[] = [];
  if (!PROFILE_BUDGET.levels.includes(req.level)) {
    reasons.push(`level ${req.level} is tier C (only ${PROFILE_BUDGET.levels.join('/')} run without confirm)`);
  }
  if (req.seconds > PROFILE_BUDGET.maxSeconds) {
    reasons.push(`${req.seconds} s is over the ${PROFILE_BUDGET.maxSeconds} s tier B limit`);
  }
  if (lastCaptureAt) {
    const age = now - lastCaptureAt.getTime();
    if (age < PROFILE_BUDGET.windowMs) {
      const waitMin = Math.ceil((PROFILE_BUDGET.windowMs - age) / 60_000);
      reasons.push(
        `this server had a capture ${Math.floor(age / 60_000)} min ago (tier B allows 1 per 30 min, next slot in ${waitMin} min)`,
      );
    }
  }
  if (reasons.length === 0) return null;
  return `outside the tier B profiling budget: ${reasons.join('; ')}. Ask the user, then resend with confirm: true.`;
}
