import './helpers/env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import { Writer } from '../src/plugins/biforesting-link/frame-codec.ts';
import { decodeSpike } from '../src/plugins/biforesting-link/profile-spike.ts';
import { ProfileUploadError, summarizeProfileReport } from '../src/plugins/biforesting-link/profile-upload.ts';

/**
 * `biforesting:spike` wire: [varint 1][varint gzLen][gz report.json]. The fixture is the mod's
 * SpikePayloads output; shared SpikePayloadsTest decodes the same bytes to the same JSON.
 */

const FIXTURE_B64 =
  'AcoBH4sIAAAAAAAA/0WOQQrDIBBF7zJrk6rB0niDLgpddFe6EGMTSZOImhIIuXtHA+mA8OfPzPetEHRnBgWSEdDKxdmbawMSgrO9Kd52SU7BKT/TuqIF4xQLCPR2PNawjd62rfEgV4hW9yArksUtgLwwXgpsO29CN32a5HFBCYTZOf' +
  'SCwSS+ERiCiynBCYo86cbVAke7qo+kQS2HVt8WN2jJ8L6bYnD4QD5XsBnP6Gin8ZSZ/tC7C+nHu/GPDMxKLrbX9gPsiAIOEQEAAA==';
const FIXTURE_JSON = {
  schema: 1,
  captureId: 'spike-fixture-20260930-120000',
  kind: 'spike',
  trigger: { tick: 3, tickMs: 812.5, thresholdMs: 250, suppressed: 2 },
  mspt: { p50: 1.5, p95: 2.5, p99: 812.5, max: 812.5, avg: 20.1 },
  hotspots: [{ id: 'section/tick', kind: 'section', msPerTick: 1.25 }],
};

function envelope(json: unknown, version = 1): Buffer {
  const gz = gzipSync(Buffer.from(JSON.stringify(json), 'utf8'));
  return Buffer.concat([new Writer().varInt(version).varInt(gz.length).build(), gz]);
}

test('spike codec: the Java fixture decodes to the same report', () => {
  assert.deepEqual(decodeSpike(Buffer.from(FIXTURE_B64, 'base64')), FIXTURE_JSON);
});

test('spike codec: a Node envelope decodes too', () => {
  assert.deepEqual(decodeSpike(envelope(FIXTURE_JSON)), FIXTURE_JSON);
});

test('spike codec: bad version, short body, non-object JSON are rejected', () => {
  assert.throws(() => decodeSpike(envelope(FIXTURE_JSON, 2)), /version 2/);
  const full = envelope(FIXTURE_JSON);
  assert.throws(() => decodeSpike(full.subarray(0, full.length - 5)), /exceeds payload/);
  assert.throws(() => decodeSpike(envelope([1, 2, 3])), /not a JSON object/);
});

test('spike summary: kind spike, trigger kept, captureId taken from the report', () => {
  const s = summarizeProfileReport(decodeSpike(Buffer.from(FIXTURE_B64, 'base64')), null);
  assert.equal(s.kind, 'spike');
  assert.equal(s.captureId, 'spike-fixture-20260930-120000');
  assert.deepEqual(s.trigger, FIXTURE_JSON.trigger);
  assert.equal(s.mspt.max, 812.5);
  assert.equal(s.hotspots.length, 1);
});

test('spike summary: a report without a usable captureId is a 400', () => {
  for (const bad of [{ ...FIXTURE_JSON, captureId: undefined }, { ...FIXTURE_JSON, captureId: '../x' }]) {
    assert.throws(
      () => summarizeProfileReport(bad, null),
      (err: unknown) => err instanceof ProfileUploadError && err.statusCode === 400,
    );
  }
  const capture = summarizeProfileReport({ ...FIXTURE_JSON, kind: undefined, trigger: undefined }, null);
  assert.equal(capture.kind, 'capture');
  assert.equal(capture.trigger, null);
});
