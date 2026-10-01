import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROFILE_BUDGET, profileBudgetError, profileCaptureExecTimeoutMs } from '../src/domains/biforesting/profile-budget.ts';

/** Tier B runs without confirm: l0/l1, at most 60 s, 1 capture per server per 30 min. */

const NOW = 1_780_000_000_000;

test('profile budget: l0 and l1 up to 60 s with no recent capture fit tier B', () => {
  assert.equal(profileBudgetError({ seconds: 60, level: 'l1' }, null, NOW), null);
  assert.equal(profileBudgetError({ seconds: 1, level: 'l0' }, null, NOW), null);
});

test('profile budget: l2 needs confirm', () => {
  assert.match(profileBudgetError({ seconds: 10, level: 'l2' }, null, NOW)!, /level l2 is tier C/);
});

test('profile budget: over 60 s needs confirm', () => {
  assert.match(profileBudgetError({ seconds: 61, level: 'l1' }, null, NOW)!, /61 s is over the 60 s/);
});

test('profile budget: a capture inside the 30 min window needs confirm and names the next slot', () => {
  const tenMinAgo = new Date(NOW - 10 * 60_000);
  const reason = profileBudgetError({ seconds: 30, level: 'l1' }, tenMinAgo, NOW)!;
  assert.match(reason, /had a capture 10 min ago/);
  assert.match(reason, /next slot in 20 min/);
  assert.match(reason, /confirm: true/);

  const edge = new Date(NOW - PROFILE_BUDGET.windowMs);
  assert.equal(profileBudgetError({ seconds: 30, level: 'l1' }, edge, NOW), null, 'the window has passed');
});

test('profile budget: every broken rule is listed in one reason', () => {
  const reason = profileBudgetError({ seconds: 120, level: 'l2' }, new Date(NOW - 60_000), NOW)!;
  assert.match(reason, /level l2/);
  assert.match(reason, /120 s/);
  assert.match(reason, /1 min ago|0 min ago/);
});

test('profile budget: the exec timeout is the capture length plus a 2 min margin', () => {
  assert.equal(profileCaptureExecTimeoutMs(60), 180_000);
  assert.equal(profileCaptureExecTimeoutMs(600), 720_000);
});
