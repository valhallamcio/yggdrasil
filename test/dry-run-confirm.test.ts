import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dryRunConfirmError, DRY_RUN_CONFIRM_WINDOW_MS } from '../src/domains/biforesting/ops-catalog.ts';

/** Destructive-apply guard (phase 5): apply must cite a fresh completed dry-run, same type+target+server. */

const NOW = 1_700_000_000_000;

function dry(overrides: Record<string, unknown> = {}) {
  return {
    state: 'completed',
    type: 'remove_item',
    instanceKey: 'pack-a',
    flags: { dryRun: true },
    target: { name: 'Steve' },
    completedAt: new Date(NOW - 60_000),
    ...overrides,
  } as Parameters<typeof dryRunConfirmError>[0];
}

const APPLY = { type: 'remove_item', instanceKey: 'pack-a', target: { name: 'steve' } };

test('dry-run confirm: fresh completed dry-run of same type+target authorizes (name match is case-insensitive)', () => {
  assert.equal(dryRunConfirmError(dry(), APPLY, NOW), null);
});

test('dry-run confirm: every mismatch rejects with a reason', () => {
  assert.match(dryRunConfirmError(null, APPLY, NOW)!, /not found/);
  assert.match(dryRunConfirmError(dry({ state: 'pending' }), APPLY, NOW)!, /not completed/);
  assert.match(dryRunConfirmError(dry({ type: 'give_item' }), APPLY, NOW)!, /type differs/);
  assert.match(dryRunConfirmError(dry({ instanceKey: 'pack-b' }), APPLY, NOW)!, /different server/);
  assert.match(dryRunConfirmError(dry({ flags: {} }), APPLY, NOW)!, /not a dry-run/);
  assert.match(dryRunConfirmError(dry({ target: { name: 'Alex' } }), APPLY, NOW)!, /different player/);
  assert.match(
    dryRunConfirmError(dry({ completedAt: new Date(NOW - DRY_RUN_CONFIRM_WINDOW_MS) }), APPLY, NOW)!,
    /older than 15 min/,
  );
});

test('dry-run confirm: uuid targets match on uuid even when names are absent', () => {
  const d = dry({ target: { uuid: 'u-1' } });
  assert.equal(dryRunConfirmError(d, { ...APPLY, target: { uuid: 'u-1' } }, NOW), null);
  assert.match(dryRunConfirmError(d, { ...APPLY, target: { uuid: 'u-2' } }, NOW)!, /different player/);
});
