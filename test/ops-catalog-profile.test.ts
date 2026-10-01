import './helpers/env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { catalogEntry } from '../src/domains/biforesting/ops-catalog.ts';
import { profileCaptureBodySchema, profileArtifactParamsSchema } from '../src/domains/biforesting/biforesting.schema.ts';
import { FEATURE_BITS, featureNamesForMask } from '../src/plugins/biforesting-link/policy-store.ts';

/** profile_capture / profile_stop catalog entries and the profiler policy bits. */

test('policy bits: profiler is 0x20000 and spike_catcher 0x40000 is reserved', () => {
  assert.equal(FEATURE_BITS['profiler'], 0x20000);
  assert.equal(FEATURE_BITS['spike_catcher'], 0x40000);
  assert.deepEqual(featureNamesForMask(0x20400), ['ops', 'profiler']);
});

test('profile_capture: server-global, gated on the profiler bit, defaults filled in', () => {
  const entry = catalogEntry('profile_capture');
  assert.ok(entry);
  assert.equal(entry.serverGlobal, true);
  assert.equal(entry.requiresFeature, 'profiler');
  assert.equal(entry.requiresConfirm, undefined, 'the budget decides when confirm is needed');
  const parsed = entry.params.safeParse({});
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data, { seconds: 30, level: 'l1', sampler: 'java' });
});

test('profile_capture: seconds 1..600, level l0|l1|l2, sampler none|java|jfr', () => {
  const p = catalogEntry('profile_capture')!.params;
  assert.equal(p.safeParse({ seconds: 1, level: 'l0', sampler: 'none' }).success, true);
  assert.equal(p.safeParse({ seconds: 600, level: 'l2', sampler: 'jfr' }).success, true);
  assert.equal(p.safeParse({ seconds: 0 }).success, false);
  assert.equal(p.safeParse({ seconds: 601 }).success, false);
  assert.equal(p.safeParse({ seconds: 2.5 }).success, false);
  assert.equal(p.safeParse({ level: 'L1' }).success, false);
  assert.equal(p.safeParse({ level: 'l3' }).success, false);
  assert.equal(p.safeParse({ sampler: 'async' }).success, false);
});

test('profile_capture: callers cannot inject the upload grant', () => {
  const p = catalogEntry('profile_capture')!.params;
  assert.equal(p.safeParse({ uploadToken: 'x', uploadUrl: 'https://evil.example/' }).success, false);
});

test('profile_stop: empty params, gated on the profiler bit', () => {
  const entry = catalogEntry('profile_stop')!;
  assert.equal(entry.requiresFeature, 'profiler');
  assert.equal(entry.serverGlobal, true);
  assert.equal(entry.params.safeParse({}).success, true);
  assert.equal(entry.params.safeParse({ seconds: 5 }).success, false);
});

test('POST /profiles body: capture params plus an optional confirm', () => {
  assert.deepEqual(profileCaptureBodySchema.parse({ seconds: 5 }), { seconds: 5, level: 'l1', sampler: 'java' });
  assert.equal(profileCaptureBodySchema.parse({ level: 'l2', confirm: true }).confirm, true);
  assert.equal(profileCaptureBodySchema.safeParse({ confirm: 'yes' }).success, false);
});

test('artifact route params: allowlisted artifact names and a strict captureId', () => {
  const ok = { server: 'gtse', captureId: 'cap-2026.09_30', artifact: 'trace.json.gz' };
  assert.equal(profileArtifactParamsSchema.safeParse(ok).success, true);
  for (const artifact of ['report.json', 'report.md', 'samples.collapsed', 'samples.jfr']) {
    assert.equal(profileArtifactParamsSchema.safeParse({ ...ok, artifact }).success, true, artifact);
  }
  assert.equal(profileArtifactParamsSchema.safeParse({ ...ok, artifact: 'trace.json' }).success, false);
  assert.equal(profileArtifactParamsSchema.safeParse({ ...ok, artifact: '../x' }).success, false);
  assert.equal(profileArtifactParamsSchema.safeParse({ ...ok, captureId: 'a/b' }).success, false);
  assert.equal(profileArtifactParamsSchema.safeParse({ ...ok, captureId: 'x'.repeat(129) }).success, false);
  assert.equal(profileArtifactParamsSchema.safeParse({ ...ok, captureId: '' }).success, false);
});

test('profile_fetch: server-global, gated on the profiler bit, captureId required', () => {
  const entry = catalogEntry('profile_fetch')!;
  assert.equal(entry.requiresFeature, 'profiler');
  assert.equal(entry.serverGlobal, true);
  const p = entry.params;
  assert.equal(p.safeParse({ captureId: 'spike-gtse-20260930-120000' }).success, true);
  assert.equal(p.safeParse({ captureId: 'srv-20260930-120000-2', artifacts: ['trace.json.gz', 'report.json'] }).success, true);
  assert.equal(p.safeParse({}).success, false);
  assert.equal(p.safeParse({ captureId: '..' }).success, false, 'no parent directory');
  assert.equal(p.safeParse({ captureId: '.' }).success, false);
  assert.equal(p.safeParse({ captureId: 'a/b' }).success, false);
  assert.equal(p.safeParse({ captureId: 'x', artifacts: [] }).success, false);
  assert.equal(p.safeParse({ captureId: 'x', artifacts: ['level.dat'] }).success, false);
  assert.equal(p.safeParse({ captureId: 'x', uploadToken: 't' }).success, false, 'no injected grant');
});
