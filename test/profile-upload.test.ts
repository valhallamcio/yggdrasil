import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  ArtifactVerifier,
  ProfileUploadError,
  REPORT_TOP_HOTSPOTS,
  UPLOAD_WINDOW_MS,
  parseProfileReport,
  signUpload,
  uploadSigningString,
  verifyUpload,
  type UploadGrantView,
  type UploadRequest,
} from '../src/plugins/biforesting-link/profile-upload.ts';

/** Profiler artifact upload: header auth, streamed body check, report.json parse. */

const KEY = randomBytes(32);
const NOW = 1_780_000_000_000;
const BODY = Buffer.from('{"schema":1}');
const SHA = createHash('sha256').update(BODY).digest('hex');
const TOKEN = randomBytes(32).toString('base64url');

function grant(overrides: Partial<UploadGrantView> = {}): UploadGrantView {
  return { instanceKey: 'gtse', captureId: null, expiresAt: new Date(NOW + 60_000), ...overrides };
}

function req(overrides: Partial<UploadRequest> = {}, ts = NOW): UploadRequest {
  const base = { serverId: 'srv-1', captureId: 'cap-1', artifact: 'report.json', instanceKey: 'gtse' };
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    token: TOKEN,
    timestamp: String(ts),
    contentSha256: SHA,
    signature: signUpload(KEY, merged.serverId, merged.captureId, merged.artifact, SHA, ts),
    ...overrides,
  };
}

test('upload auth: the signing string is the five fields joined by newlines', () => {
  assert.equal(uploadSigningString('srv', 'cap', 'trace.json.gz', 'ab', 123), 'srv\ncap\ntrace.json.gz\nab\n123');
  const expected = createHmac('sha256', KEY).update('srv\ncap\ntrace.json.gz\nab\n123').digest('hex');
  assert.equal(signUpload(KEY, 'srv', 'cap', 'trace.json.gz', 'ab', 123), expected);
});

test('upload auth: a good signature with a live grant passes and returns the lowercase hash', () => {
  const upper = req({ contentSha256: SHA.toUpperCase() });
  upper.signature = signUpload(KEY, 'srv-1', 'cap-1', 'report.json', SHA, NOW);
  assert.deepEqual(verifyUpload(upper, grant(), KEY, NOW), { ok: true, contentSha256: SHA });
  assert.equal(verifyUpload(req(), grant({ captureId: 'cap-1' }), KEY, NOW).ok, true, 'same capture again');
});

test('upload auth: a bad signature is 401', () => {
  const r = req();
  r.signature = signUpload(randomBytes(32), 'srv-1', 'cap-1', 'report.json', SHA, NOW);
  assert.deepEqual(verifyUpload(r, grant(), KEY, NOW), { ok: false, status: 401, reason: 'signature mismatch' });

  // Each signed field is bound: a changed artifact or capture breaks the signature.
  const moved = { ...req(), artifact: 'trace.json.gz' };
  assert.equal((verifyUpload(moved, grant(), KEY, NOW) as { status: number }).status, 401);
  const otherCapture = { ...req(), captureId: 'cap-2' };
  assert.equal((verifyUpload(otherCapture, grant(), KEY, NOW) as { status: number }).status, 401);
});

test('upload auth: a timestamp outside 30 s is 401', () => {
  const stale = req({}, NOW - UPLOAD_WINDOW_MS - 1);
  const v = verifyUpload(stale, grant(), KEY, NOW);
  assert.equal(v.ok, false);
  assert.equal((v as { status: number }).status, 401);
  assert.match((v as { reason: string }).reason, /window/);
  assert.equal(verifyUpload(req({}, NOW + UPLOAD_WINDOW_MS + 1), grant(), KEY, NOW).ok, false, 'future skew too');
  assert.equal(verifyUpload(req({}, NOW - UPLOAD_WINDOW_MS), grant(), KEY, NOW).ok, true, 'edge of the window');
});

test('upload auth: a token bound to another server is 403', () => {
  const v = verifyUpload(req(), grant({ instanceKey: 'arcadia' }), KEY, NOW);
  assert.deepEqual(v, { ok: false, status: 403, reason: 'upload token belongs to another server' });
});

test('upload auth: unknown, expired, and other-capture tokens are refused', () => {
  assert.deepEqual(verifyUpload(req(), null, KEY, NOW), { ok: false, status: 401, reason: 'unknown upload token' });
  assert.deepEqual(verifyUpload(req(), grant({ expiresAt: new Date(NOW) }), KEY, NOW), {
    ok: false,
    status: 401,
    reason: 'upload token expired',
  });
  const bound = verifyUpload(req(), grant({ captureId: 'cap-0' }), KEY, NOW);
  assert.equal((bound as { status: number }).status, 403);
});

test('upload auth: missing or malformed headers are refused before any crypto', () => {
  assert.equal((verifyUpload(req({ token: undefined }), grant(), KEY, NOW) as { status: number }).status, 401);
  assert.equal((verifyUpload(req({ timestamp: 'soon' }), grant(), KEY, NOW) as { status: number }).status, 400);
  assert.equal((verifyUpload(req({ contentSha256: 'abc' }), grant(), KEY, NOW) as { status: number }).status, 400);
  assert.equal((verifyUpload(req({ signature: 'zz' }), grant(), KEY, NOW) as { status: number }).status, 401);
});

async function runVerifier(body: Buffer, sha: string, max: number, onBody?: (b: Buffer) => void): Promise<Buffer> {
  const out: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      out.push(chunk);
      cb();
    },
  });
  // Several chunks, so the hash and the byte count run across writes.
  const parts = [body.subarray(0, 5), body.subarray(5)];
  await pipeline(Readable.from(parts), new ArtifactVerifier(sha, max, onBody), sink);
  return Buffer.concat(out);
}

test('upload body: a matching hash passes the bytes through unchanged', async () => {
  const out = await runVerifier(BODY, SHA, 1024);
  assert.deepEqual(out, BODY);
});

test('upload body: a hash mismatch fails with 400 at the end of the stream', async () => {
  const wrong = createHash('sha256').update('other').digest('hex');
  await assert.rejects(runVerifier(BODY, wrong, 1024), (err: unknown) => {
    assert.ok(err instanceof ProfileUploadError);
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /does not match/);
    return true;
  });
});

test('upload body: a body over the cap fails with 413', async () => {
  await assert.rejects(runVerifier(BODY, SHA, BODY.length - 1), (err: unknown) => {
    assert.ok(err instanceof ProfileUploadError);
    assert.equal(err.statusCode, 413);
    return true;
  });
});

test('upload body: onBody sees the whole body, and its error fails the stream', async () => {
  let seen: Buffer | null = null;
  await runVerifier(BODY, SHA, 1024, (b) => {
    seen = b;
  });
  assert.deepEqual(seen, BODY);
  await assert.rejects(
    runVerifier(BODY, SHA, 1024, () => {
      throw new ProfileUploadError(400, 'bad report');
    }),
    /bad report/,
  );
});

function report(extra: Record<string, unknown> = {}): Buffer {
  const hotspots = Array.from({ length: 60 }, (_, i) => ({ id: `entity/m:e${i}`, kind: 'entity', mod: 'm', msPerTick: 60 - i }));
  return Buffer.from(
    JSON.stringify({
      schema: 1,
      captureId: 'cap-1',
      startedAt: '2026-09-30T17:16:44.944Z',
      stoppedAt: '2026-09-30T17:16:46.987Z',
      durationMs: 2041.2,
      stopReason: 'maxSeconds',
      level: 'L1',
      sampler: 'java',
      truncated: false,
      tickCount: 42,
      analysisTicks: 42,
      mspt: { p50: 1.1, p95: 1.5, p99: 60.7, max: 60.7, avg: 2.9 },
      tps: 20.1,
      hotspotsTotal: 60,
      hotspots,
      worstTicks: [{ tick: 24, ms: 60.7, zones: [] }],
      mods: [{ mod: 'gtceu', msPerTick: 2.0 }],
      ...extra,
    }),
  );
}

test('report parse: a schema 1 report yields the summary with the top 50 hotspots', () => {
  const s = parseProfileReport(report(), 'cap-1');
  assert.equal(s.schema, 1);
  assert.equal(s.level, 'L1');
  assert.equal(s.tickCount, 42);
  assert.equal(s.mspt.p99, 60.7);
  assert.equal(s.tps, 20.1);
  assert.equal(s.hotspots.length, REPORT_TOP_HOTSPOTS);
  assert.equal(s.hotspots[0]!['msPerTick'], 60);
  assert.equal(s.hotspotsTotal, 60);
  assert.equal(s.startedAt?.toISOString(), '2026-09-30T17:16:44.944Z');
  assert.equal(s.worstTicks.length, 1);
  assert.equal(s.mods.length, 1);
});

test('report parse: bad JSON, a non-object, another schema, or another captureId is 400', () => {
  const bad = (body: Buffer, re: RegExp) =>
    assert.throws(() => parseProfileReport(body, 'cap-1'), (err: unknown) => {
      assert.ok(err instanceof ProfileUploadError);
      assert.equal(err.statusCode, 400);
      assert.match(err.message, re);
      return true;
    });
  bad(Buffer.from('{"schema":1'), /does not parse/);
  bad(Buffer.from('[1,2]'), /JSON object/);
  bad(report({ schema: 2 }), /schema 2 is not supported/);
  bad(report({ schema: '1' }), /not supported/);
  bad(report({ captureId: 'cap-9' }), /does not match/);
});
