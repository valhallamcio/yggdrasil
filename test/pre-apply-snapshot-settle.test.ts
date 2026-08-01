import { test } from 'node:test';
import assert from 'node:assert/strict';

import { settlePreApplySnapshot } from '../src/domains/biforesting/settle-snapshot.ts';

// The pre-apply snapshot and the apply both claim the mod-side OfflineEditGuard for the same
// uuid. Dispatching them concurrently made the apply lose a ~6 ms race and fail with
// "another offline edit is running" — intermittently (found on the mce2 canary 2026-08-01).
// The apply must not be created until the snapshot has left flight.

function storeReturning(states: string[]) {
  let i = 0;
  const calls: number[] = [];
  return {
    calls,
    async get() {
      const state = states[Math.min(i, states.length - 1)];
      i += 1;
      calls.push(i);
      return { state };
    },
  };
}

test('settle: returns immediately once the snapshot is completed', async () => {
  const store = storeReturning(['completed']);
  const t0 = Date.now();
  await settlePreApplySnapshot('X', store, 3000);
  assert.equal(store.calls.length, 1, 'one poll is enough when already terminal');
  assert.ok(Date.now() - t0 < 200, 'must not sleep when already settled');
});

test('settle: waits through pending/dispatched/acked, then proceeds', async () => {
  const store = storeReturning(['pending', 'dispatched', 'acked', 'completed']);
  await settlePreApplySnapshot('X', store, 3000);
  assert.equal(store.calls.length, 4, 'polls until the op leaves flight');
});

test('settle: a failed snapshot still releases the apply (best-effort)', async () => {
  const store = storeReturning(['dispatched', 'failed']);
  await settlePreApplySnapshot('X', store, 3000);
  assert.equal(store.calls.length, 2);
});

test('settle: waiting_player counts as settled — the guard is not held while parked', async () => {
  const store = storeReturning(['waiting_player']);
  await settlePreApplySnapshot('X', store, 3000);
  assert.equal(store.calls.length, 1);
});

test('settle: a missing op does not hang', async () => {
  let calls = 0;
  const store = { async get() { calls += 1; return null; } };
  await settlePreApplySnapshot('X', store, 3000);
  assert.equal(calls, 1);
});

test('settle: a stuck snapshot times out instead of wedging the apply', async () => {
  const store = storeReturning(['acked']); // never leaves flight
  const t0 = Date.now();
  await settlePreApplySnapshot('X', store, 200);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 190, 'honours the budget');
  assert.ok(elapsed < 1500, 'gives up rather than blocking forever');
});
