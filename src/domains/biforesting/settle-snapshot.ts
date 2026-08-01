/**
 * Sequencing helper for the auto-prepended pre-apply snapshot.
 *
 * The snapshot and the apply it protects both claim the mod-side `OfflineEditGuard` for the same
 * uuid on the offline `.dat` path. Dispatching them concurrently made the apply lose a ~6 ms race
 * and fail with "another offline edit is running" — intermittently, so tests never caught it
 * (found on the mce2 canary, 2026-08-01). The apply must not be created until the snapshot has
 * left flight.
 *
 * Deliberately dependency-free so it is unit-testable without booting config or Mongo.
 */

/** States in which the snapshot may still hold the guard. `waiting_player` is parked — not held. */
export const SNAPSHOT_IN_FLIGHT: ReadonlySet<string> = new Set(['pending', 'dispatched', 'acked']);
export const SNAPSHOT_SETTLE_TIMEOUT_MS = 3_000;
export const SNAPSHOT_POLL_MS = 25;

export interface SnapshotStateReader {
  get(opId: string): Promise<{ state: string } | null>;
}

/**
 * Block until the snapshot leaves flight. Bounded and best-effort: on timeout we return and let
 * the apply proceed, because a stuck snapshot must never wedge the operation it exists to protect.
 */
export async function settlePreApplySnapshot(
  opId: string,
  store: SnapshotStateReader,
  timeoutMs: number = SNAPSHOT_SETTLE_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = await store.get(opId);
    if (!snap || !SNAPSHOT_IN_FLIGHT.has(snap.state)) return;
    await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_POLL_MS));
  }
}
