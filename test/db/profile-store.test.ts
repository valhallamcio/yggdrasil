import '../helpers/env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { ObjectId } from 'mongodb';

import { startTestMongo, type TestMongo } from '../helpers/mongo.ts';
import { OpsStore } from '../../src/plugins/biforesting-link/ops-store.ts';
import { OpDispatcher } from '../../src/plugins/biforesting-link/op-dispatcher.ts';
import { decodeJsonPayload } from '../../src/plugins/biforesting-link/decoders.ts';
import { setPolicy, setPolicyDbProvider, maskForFeatures } from '../../src/plugins/biforesting-link/policy-store.ts';
import {
  PROFILE_RETENTION_MS,
  UPLOAD_GRACE_MS,
  bindGrantCapture,
  cleanupProfiles,
  findUploadGrant,
  fleetHotspots,
  listArtifacts,
  listCaptures,
  openArtifact,
  readReport,
  setProfileDbProvider,
  storeArtifact,
  storeSpikeReport,
} from '../../src/plugins/biforesting-link/profile-store.ts';
import { ProfileUploadError, type ProfileArtifact } from '../../src/plugins/biforesting-link/profile-upload.ts';

/** Profiler storage: upload grants at dispatch, GridFS artifacts, report summaries, fleet ranking, retention. */

const DB = 'ygg_profile_test';
let mongo: TestMongo;
let store: OpsStore;

before(async () => {
  mongo = await startTestMongo();
  const db = () => mongo.client.db(DB);
  store = new OpsStore(db);
  setPolicyDbProvider(db);
  setProfileDbProvider(db);
});
after(async () => mongo.stop());

function mkPort(linkIds: Record<string, string> = {}) {
  const sent: Array<{ instanceKey: string; body: Record<string, unknown> }> = [];
  const live = new Set<string>();
  return {
    sent,
    live,
    sendDown: (instanceKey: string, _channel: string, payload: Buffer) => {
      if (!live.has(instanceKey)) return false;
      sent.push({ instanceKey, body: decodeJsonPayload(payload) as Record<string, unknown> });
      return true;
    },
    liveInstanceKeys: () => [...live],
    linkServerIdFor: (instanceKey: string) => linkIds[instanceKey] ?? null,
  };
}

function captureInput(instanceKey: string) {
  return {
    instanceKey,
    serverTag: instanceKey,
    type: 'profile_capture',
    params: { seconds: 5, level: 'l1', sampler: 'java' },
    execTimeoutMs: 125_000,
    createdBy: 'test',
  };
}

function report(captureId: string, hotspots: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema: 1,
      captureId,
      startedAt: '2026-09-30T17:16:44.944Z',
      stoppedAt: '2026-09-30T17:16:46.987Z',
      durationMs: 2041.2,
      level: 'L1',
      sampler: 'java',
      truncated: false,
      tickCount: 42,
      analysisTicks: 42,
      mspt: { p50: 1.1, p95: 1.5, p99: 60.7, max: 60.7, avg: 2.9 },
      tps: 20.1,
      hotspotsTotal: hotspots.length,
      hotspots,
      worstTicks: [{ tick: 24, ms: 60.7, zones: [] }],
      mods: [{ mod: 'gtceu', msPerTick: 2 }],
      ...extra,
    }),
  );
}

function sha(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

async function put(instanceKey: string, captureId: string, artifact: ProfileArtifact, body: Buffer, hash = sha(body)) {
  return storeArtifact({
    source: Readable.from([body.subarray(0, 3), body.subarray(3)]),
    serverId: `link-${instanceKey}`,
    instanceKey,
    captureId,
    artifact,
    sha256: hash,
    opId: `op-${captureId}`,
  });
}

async function fileCount(instanceKey: string, captureId: string): Promise<{ files: number; chunks: number }> {
  const db = mongo.client.db(DB);
  const files = await db
    .collection('biforesting_profiles.files')
    .find({ 'metadata.instanceKey': instanceKey, 'metadata.captureId': captureId })
    .toArray();
  const chunks = await db.collection('biforesting_profiles.chunks').countDocuments({ files_id: { $in: files.map((f) => f._id) } });
  return { files: files.length, chunks };
}

async function allChunks(): Promise<number> {
  return mongo.client.db(DB).collection('biforesting_profiles.chunks').countDocuments();
}

test('dispatch: profile_capture carries a fresh upload grant; the stored op does not', async () => {
  await setPolicy('gtse', { enabledFeatures: maskForFeatures(['play_transport', 'ops', 'profiler']) }, 'test');
  const port = mkPort({ gtse: 'srv-uuid-1' });
  port.live.add('gtse');
  const d = new OpDispatcher(store, port);

  const { op } = await store.create(captureInput('gtse'));
  const before = Date.now();
  await d.onOpCreated(op);

  assert.equal(port.sent.length, 1);
  const params = port.sent[0]!.body['params'] as Record<string, unknown>;
  assert.equal(params['seconds'], 5);
  assert.match(String(params['uploadToken']), /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');
  assert.equal(params['uploadUrl'], 'https://api.valhallamc.dev/v1/biforesting/srv-uuid-1/profiles/');

  const stored = await store.get(op._id);
  assert.equal(stored?.params['uploadToken'], undefined, 'token never lands on the op doc');

  const grant = await findUploadGrant(String(params['uploadToken']));
  assert.ok(grant);
  assert.equal(grant.opId, op._id);
  assert.equal(grant.instanceKey, 'gtse');
  assert.equal(grant.serverId, 'srv-uuid-1');
  assert.equal(grant.captureId, null);
  const minExpiry = before + op.dispatchTimeoutMs + op.execTimeoutMs + UPLOAD_GRACE_MS;
  assert.ok(grant.expiresAt.getTime() >= minExpiry, 'op deadline + 30 min');
  assert.ok(grant.expiresAt.getTime() < minExpiry + 60_000);

  // At-least-once: a re-dispatch of the same op reuses the token the mod already has.
  await store.requeueUnwritable(op._id);
  await d.onLinkUp('gtse');
  assert.equal(port.sent.length, 2);
  const again = port.sent[1]!.body['params'] as Record<string, unknown>;
  assert.equal(again['uploadToken'], params['uploadToken']);
});

test('dispatch: without the profiler bit a pending capture fails instead of firing later', async () => {
  await setPolicy('arcadia', { enabledFeatures: maskForFeatures(['play_transport', 'ops']) }, 'test');
  const port = mkPort({ arcadia: 'srv-arc' });
  port.live.add('arcadia');
  const d = new OpDispatcher(store, port);

  const { op } = await store.create(captureInput('arcadia'));
  await d.onOpCreated(op);
  assert.equal(port.sent.length, 0);
  const failed = await store.get(op._id);
  assert.equal(failed?.state, 'failed');
  assert.match(failed?.result?.error ?? '', /feature 'profiler' is not granted/);
});

test('grant: binds to the first capture and refuses another one', async () => {
  await setPolicy('bind', { enabledFeatures: maskForFeatures(['ops', 'profiler']) }, 'test');
  const port = mkPort();
  port.live.add('bind');
  const d = new OpDispatcher(store, port);
  const { op } = await store.create(captureInput('bind'));
  await d.onOpCreated(op);
  const token = String((port.sent[0]!.body['params'] as Record<string, unknown>)['uploadToken']);
  assert.equal(
    (port.sent[0]!.body['params'] as Record<string, unknown>)['uploadUrl'],
    'https://api.valhallamc.dev/v1/biforesting/bind/profiles/',
    'no live link id: falls back to the instanceKey',
  );

  assert.equal(await bindGrantCapture(token, 'cap-a'), true);
  assert.equal(await bindGrantCapture(token, 'cap-a'), true, 'more artifacts of the same capture');
  assert.equal(await bindGrantCapture(token, 'cap-b'), false);
  assert.equal((await findUploadGrant(token))?.captureId, 'cap-a');
});

test('upload: report.json is stored, parsed into a summary, and read back in full', async () => {
  const hotspots = Array.from({ length: 70 }, (_, i) => ({ id: `block_entity/gtceu:m${i}`, kind: 'block_entity', mod: 'gtceu', msPerTick: 70 - i }));
  const body = report('cap-r1', hotspots);
  const res = await put('gtse', 'cap-r1', 'report.json', body);
  assert.deepEqual(res, { size: body.length, report: true });

  const doc = await mongo.client.db(DB).collection('biforesting_profile_reports').findOne({ instanceKey: 'gtse', captureId: 'cap-r1' });
  assert.ok(doc);
  assert.equal(doc['serverId'], 'link-gtse');
  assert.equal(doc['opId'], 'op-cap-r1');
  assert.equal(doc['schema'], 1);
  assert.equal(doc['level'], 'L1');
  assert.equal(doc['tickCount'], 42);
  assert.equal((doc['hotspots'] as unknown[]).length, 50, 'top 50 only');
  assert.equal(doc['hotspotsTotal'], 70);
  assert.ok(doc['createdAt'] instanceof Date);

  const full = (await readReport('gtse', 'cap-r1')) as { hotspots: unknown[] };
  assert.equal(full.hotspots.length, 70, 'GridFS keeps the whole file');

  const [art] = await listArtifacts('gtse', 'cap-r1');
  assert.equal(art?.artifact, 'report.json');
  assert.equal(art?.size, body.length);
  assert.equal(art?.sha256, sha(body));
});

test('upload: a second copy of the same artifact is 409', async () => {
  const body = Buffer.from('trace-bytes-1');
  await put('gtse', 'cap-dup', 'trace.json.gz', body);
  await assert.rejects(put('gtse', 'cap-dup', 'trace.json.gz', body), (err: unknown) => {
    assert.ok(err instanceof ProfileUploadError);
    assert.equal(err.statusCode, 409);
    return true;
  });
  assert.deepEqual(await fileCount('gtse', 'cap-dup'), { files: 1, chunks: 1 });
});

test('upload: a hash mismatch is 400 and leaves no file and no chunks', async () => {
  const chunksBefore = await allChunks();
  const body = Buffer.alloc(600 * 1024, 7); // spans several GridFS chunks
  await assert.rejects(put('gtse', 'cap-bad', 'samples.jfr', body, sha(Buffer.from('other'))), (err: unknown) => {
    assert.ok(err instanceof ProfileUploadError);
    assert.equal(err.statusCode, 400);
    return true;
  });
  assert.deepEqual(await fileCount('gtse', 'cap-bad'), { files: 0, chunks: 0 });
  assert.equal(await allChunks(), chunksBefore, 'no stray chunks');
  assert.equal(await openArtifact('gtse', 'cap-bad', 'samples.jfr'), null);
});

test('upload: a report.json that does not parse or has another schema is 400 and not stored', async () => {
  for (const [captureId, body] of [
    ['cap-nojson', Buffer.from('{"schema": 1,')],
    ['cap-schema2', report('cap-schema2', [], { schema: 2 })],
  ] as const) {
    await assert.rejects(put('gtse', captureId, 'report.json', body), (err: unknown) => {
      assert.ok(err instanceof ProfileUploadError);
      assert.equal(err.statusCode, 400);
      return true;
    });
    assert.deepEqual(await fileCount('gtse', captureId), { files: 0, chunks: 0 });
  }
});

test('list: newest first, report summaries plus captures that only have files', async () => {
  await put('listsrv', 'cap-old', 'report.json', report('cap-old', []));
  await put('listsrv', 'cap-old', 'report.md', Buffer.from('# old'));
  await new Promise((r) => setTimeout(r, 15));
  await put('listsrv', 'cap-new', 'trace.json.gz', Buffer.from('gz'));

  const list = await listCaptures('listsrv');
  assert.deepEqual(
    list.map((c) => [c.captureId, c.hasReport]),
    [
      ['cap-new', false],
      ['cap-old', true],
    ],
  );
  const old = list[1]!;
  assert.deepEqual(old.artifacts, ['report.json', 'report.md']);
  assert.equal(old.opId, 'op-cap-old');
  assert.equal(old.level, 'L1');
  assert.equal(old.mspt?.p99, 60.7);
  assert.equal((old as unknown as Record<string, unknown>)['hotspots'], undefined, 'summary only');
  assert.equal((await listCaptures('listsrv', 1)).length, 1);
  assert.deepEqual(await listCaptures('nobody'), []);
});

test('hotspots: ranked across each server newest report, filterable by kind and mod', async () => {
  const hs = (prefix: string, kind: string, mod: string, ms: number[]) =>
    ms.map((m, i) => ({ id: `${kind}/${prefix}${i}`, kind, mod, msPerTick: m }));
  await put('fleet-a', 'a-old', 'report.json', report('a-old', hs('stale', 'entity', 'zombies', [99])));
  await new Promise((r) => setTimeout(r, 15));
  await put('fleet-a', 'a-new', 'report.json', report('a-new', hs('a', 'block_entity', 'gtceu', [9, 2])));
  await put('fleet-b', 'b-new', 'report.json', report('b-new', hs('b', 'entity', 'minecraft', [5, 1])));

  const rows = (await fleetHotspots({ top: 500 })).filter((r) => r.server.startsWith('fleet-'));
  assert.deepEqual(
    rows.map((r) => [r.server, r.captureId, r['id'], r['msPerTick']]),
    [
      ['fleet-a', 'a-new', 'block_entity/a0', 9],
      ['fleet-b', 'b-new', 'entity/b0', 5],
      ['fleet-a', 'a-new', 'block_entity/a1', 2],
      ['fleet-b', 'b-new', 'entity/b1', 1],
    ],
    'the stale 99 ms zombie from a-old is ignored',
  );
  assert.equal(rows[0]!.serverId, 'link-fleet-a');

  const entities = await fleetHotspots({ top: 500, kind: 'entity' });
  assert.ok(entities.every((r) => r['kind'] === 'entity'));
  assert.ok(entities.some((r) => r['id'] === 'entity/b0'));
  const gt = await fleetHotspots({ top: 500, mod: 'gtceu' });
  assert.ok(gt.length >= 2 && gt.every((r) => r['mod'] === 'gtceu'));
  assert.equal((await fleetHotspots({ top: 1 })).length, 1);
});

test('cleanup: captures past 30 days lose every file, chunk and report; fresh ones stay', async () => {
  const db = mongo.client.db(DB);
  await put('ret', 'cap-expired', 'report.json', report('cap-expired', []));
  await put('ret', 'cap-expired', 'samples.jfr', Buffer.alloc(300 * 1024, 1));
  await put('ret', 'cap-fresh', 'report.json', report('cap-fresh', []));
  const old = new Date(Date.now() - PROFILE_RETENTION_MS - 60_000);
  // Only the report doc is old: the whole capture still goes.
  await db.collection('biforesting_profile_reports').updateOne({ instanceKey: 'ret', captureId: 'cap-expired' }, { $set: { createdAt: old } });

  // A chunk whose upload died before the file doc was written.
  const orphanId = ObjectId.createFromTime(Math.floor((Date.now() - 2 * 3600_000) / 1000));
  await db.collection('biforesting_profiles.chunks').insertOne({ files_id: orphanId, n: 0, data: Buffer.from('x') });

  const res = await cleanupProfiles();
  assert.equal(res.captures, 1);
  assert.equal(res.files, 2);
  assert.equal(res.reports, 1);
  assert.equal(res.orphanChunks, 1);

  assert.deepEqual(await fileCount('ret', 'cap-expired'), { files: 0, chunks: 0 });
  assert.equal(await db.collection('biforesting_profile_reports').countDocuments({ captureId: 'cap-expired' }), 0);
  assert.equal(await db.collection('biforesting_profiles.chunks').countDocuments({ files_id: orphanId }), 0);
  assert.deepEqual(await fileCount('ret', 'cap-fresh'), { files: 1, chunks: 1 });
  assert.equal(await db.collection('biforesting_profile_reports').countDocuments({ captureId: 'cap-fresh' }), 1);

  // File age alone also expires a capture.
  await db
    .collection('biforesting_profiles.files')
    .updateMany({ 'metadata.captureId': 'cap-fresh' }, { $set: { uploadDate: old } });
  const res2 = await cleanupProfiles();
  assert.equal(res2.captures, 1);
  assert.equal(await db.collection('biforesting_profile_reports').countDocuments({ captureId: 'cap-fresh' }), 0);
});

// ── spike catcher dumps (phase 6a) ───────────────────────────────────────────

function spikeReport(captureId: string, tickMs: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const r = JSON.parse(
    report(captureId, [{ id: 'section/tick', kind: 'section', mod: null, msPerTick: 99 }], {
      level: 'L0',
      sampler: 'none',
      stopReason: 'spike',
    }).toString('utf8'),
  ) as Record<string, unknown>;
  return { ...r, kind: 'spike', trigger: { tick: 7, tickMs, thresholdMs: 250, suppressed: 1 }, ...extra };
}

test('spike: the link payload report is stored as kind spike with its trigger, a replay keeps createdAt', async () => {
  const doc = await storeSpikeReport({ serverId: 'link-spk', instanceKey: 'spk', report: spikeReport('spike-spk-20260930-120000', 812.5) });
  assert.equal(doc.kind, 'spike');
  assert.equal(doc.captureId, 'spike-spk-20260930-120000');
  assert.equal(doc.opId, null);
  assert.deepEqual(doc.trigger, { tick: 7, tickMs: 812.5, thresholdMs: 250, suppressed: 1 });
  const first = doc.createdAt.getTime();
  await new Promise((r) => setTimeout(r, 15));
  const again = await storeSpikeReport({ serverId: 'link-spk', instanceKey: 'spk', report: spikeReport('spike-spk-20260930-120000', 812.5) });
  assert.equal(again.createdAt.getTime(), first, 'a replayed payload does not move the doc');
  assert.equal(
    await mongo.client.db(DB).collection('biforesting_profile_reports').countDocuments({ instanceKey: 'spk' }),
    1,
  );
  await assert.rejects(
    storeSpikeReport({ serverId: 'link-spk', instanceKey: 'spk', report: { schema: 2, captureId: 'spike-x' } }),
    (err: unknown) => err instanceof ProfileUploadError && err.statusCode === 400,
  );
});

test('spike: list filters by kind; old docs without kind count as captures', async () => {
  await put('kinds', 'kinds-20260930-100000', 'report.json', report('kinds-20260930-100000', []));
  await mongo.client
    .db(DB)
    .collection('biforesting_profile_reports')
    .insertOne({ ...JSON.parse(report('legacy-cap', []).toString('utf8')), instanceKey: 'kinds', serverId: 'x', opId: null, createdAt: new Date() });
  await storeSpikeReport({ serverId: 'link-kinds', instanceKey: 'kinds', report: spikeReport('spike-kinds-20260930-110000', 400) });
  await put('kinds', 'spike-kinds-20260930-120000', 'trace.json.gz', Buffer.from('gz'));

  const all = await listCaptures('kinds');
  assert.equal(all.length, 4);
  const spikes = await listCaptures('kinds', 50, 'spike');
  assert.deepEqual(spikes.map((c) => c.captureId).sort(), ['spike-kinds-20260930-110000', 'spike-kinds-20260930-120000']);
  const dump = spikes.find((c) => c.captureId === 'spike-kinds-20260930-110000')!;
  assert.equal(dump.kind, 'spike');
  assert.equal(dump.hasReport, true);
  assert.equal((dump.trigger as Record<string, unknown>)['tickMs'], 400);
  assert.deepEqual(dump.artifacts, [], 'no files until a fetch');
  const captures = await listCaptures('kinds', 50, 'capture');
  assert.deepEqual(captures.map((c) => c.captureId).sort(), ['kinds-20260930-100000', 'legacy-cap']);
  assert.ok(captures.every((c) => c.kind === 'capture' && c.trigger === null));
});

test('spike: a fetched report.json keeps the spike kind and the first createdAt', async () => {
  const id = 'spike-fetch-20260930-120000';
  const doc = await storeSpikeReport({ serverId: 'link-fetch', instanceKey: 'fetch', report: spikeReport(id, 300) });
  await new Promise((r) => setTimeout(r, 15));
  await put('fetch', id, 'report.json', Buffer.from(JSON.stringify(spikeReport(id, 300)), 'utf8'));
  const [entry] = await listCaptures('fetch', 50, 'spike');
  assert.equal(entry?.captureId, id);
  assert.equal(entry?.kind, 'spike');
  assert.deepEqual(entry?.artifacts, ['report.json']);
  assert.equal(entry?.opId, `op-${id}`, 'the fetch op that uploaded it');
  const stored = await mongo.client.db(DB).collection('biforesting_profile_reports').findOne({ instanceKey: 'fetch', captureId: id });
  assert.equal((stored?.['createdAt'] as Date).getTime(), doc.createdAt.getTime());
});

test('spike: fleet hotspots ignore spike dumps', async () => {
  await put('fleet-s', 's-cap', 'report.json', report('s-cap', [{ id: 'entity/s0', kind: 'entity', mod: 'm', msPerTick: 3 }]));
  await new Promise((r) => setTimeout(r, 15));
  await storeSpikeReport({ serverId: 'link-fleet-s', instanceKey: 'fleet-s', report: spikeReport('spike-fleet-s-20260930-120000', 900) });
  const rows = (await fleetHotspots({ top: 500 })).filter((r) => r.server === 'fleet-s');
  assert.deepEqual(rows.map((r) => [r.captureId, r['id']]), [['s-cap', 'entity/s0']], 'the newer spike dump does not replace the capture');
});

test('dispatch: profile_fetch carries a grant bound to its captureId', async () => {
  await setPolicy('fetchsrv', { enabledFeatures: maskForFeatures(['ops', 'profiler']) }, 'test');
  const port = mkPort({ fetchsrv: 'srv-fetch' });
  port.live.add('fetchsrv');
  const d = new OpDispatcher(store, port);
  const { op } = await store.create({
    instanceKey: 'fetchsrv',
    serverTag: 'fetchsrv',
    type: 'profile_fetch',
    params: { captureId: 'spike-srv-fetch-20260930-120000', artifacts: ['trace.json.gz'] },
    createdBy: 'test',
  });
  await d.onOpCreated(op);
  assert.equal(port.sent.length, 1);
  const params = port.sent[0]!.body['params'] as Record<string, unknown>;
  assert.equal(params['captureId'], 'spike-srv-fetch-20260930-120000');
  assert.deepEqual(params['artifacts'], ['trace.json.gz']);
  assert.equal(params['uploadUrl'], 'https://api.valhallamc.dev/v1/biforesting/srv-fetch/profiles/');
  const token = String(params['uploadToken']);
  const grant = await findUploadGrant(token);
  assert.equal(grant?.captureId, 'spike-srv-fetch-20260930-120000', 'bound before the first upload');
  assert.equal(await bindGrantCapture(token, 'spike-srv-fetch-20260930-120000'), true);
  assert.equal(await bindGrantCapture(token, 'another-capture'), false, 'a fetch token opens only its capture');
  assert.equal((await store.get(op._id))?.params['uploadToken'], undefined);
});

test('dispatch: without the profiler bit a pending profile_fetch fails', async () => {
  await setPolicy('nofetch', { enabledFeatures: maskForFeatures(['ops', 'spike_catcher']) }, 'test');
  const port = mkPort();
  port.live.add('nofetch');
  const d = new OpDispatcher(store, port);
  const { op } = await store.create({
    instanceKey: 'nofetch',
    serverTag: 'nofetch',
    type: 'profile_fetch',
    params: { captureId: 'spike-x-20260930-120000' },
    createdBy: 'test',
  });
  await d.onOpCreated(op);
  assert.equal(port.sent.length, 0);
  assert.match((await store.get(op._id))?.result?.error ?? '', /feature 'profiler' is not granted/);
});
