#!/usr/bin/env node
/**
 * bfprof: agent CLI for Biforesting profiler captures (profiler plan phase 4). It wraps the
 * Yggdrasil profiles API. No dependencies beyond Node 20+.
 *
 *   YGGDRASIL_URL=http://127.0.0.1:3123 YGG_API_KEY=<key> node scripts/bfprof.mjs <command> ...
 *
 *   capture <server> [seconds] [level] [sampler] [--confirm] [--wait]
 *       Enqueue a capture (defaults 30 s, l1, java). --wait polls the op, then waits for
 *       report.json and prints the summary. --confirm lifts the tier B budget (ask first).
 *   list <server> [--kind capture|spike]          captures, newest first
 *   spikes <server> [--json]                      spike catcher dumps, newest first (trigger tick, threshold, skips)
 *   fetch <server> <captureId> [artifact...] [--wait]
 *       Ask the server to upload a capture it already has on disk (a spike dump, a command
 *       capture). No artifacts means all it has. --wait polls the op and prints the result.
 *   report <server> <captureId> [--json]          summary, or the full report.json
 *   get <server> <captureId> <artifact> [-o file] download one artifact (sha256 checked)
 *   hotspots [--top N] [--kind K] [--mod M]       fleet ranking from each server's newest report
 *   perfetto <server> <captureId>                 15 min browser link that opens the trace in Perfetto
 *   to-tracy <trace.json.gz> <out.tracy>          convert with tracy-import-chrome
 *
 * Env: YGGDRASIL_URL (or YGG_URL), YGG_API_KEY (or the first of API_KEYS), YGG_API_KEY_HEADER
 * (default X-API-Key), TRACY_IMPORT_CHROME (path to tracy-import-chrome).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gunzipSync } from 'node:zlib';

const base = (process.env.YGGDRASIL_URL ?? process.env.YGG_URL ?? 'http://127.0.0.1:3123').replace(/\/+$/, '');
const apiKey = process.env.YGG_API_KEY ?? process.env.API_KEYS?.split(',')[0]?.trim();
const apiKeyHeader = process.env.YGG_API_KEY_HEADER ?? 'X-API-Key';
const TRACY_IMPORT =
  process.env.TRACY_IMPORT_CHROME ??
  '/home/alp/GitHub/valhallamc/bifrost-lib/sources/tracy/import/build/tracy-import-chrome';
const TERMINAL = new Set(['completed', 'failed', 'expired', 'cancelled']);

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a === '--confirm' || a === '--wait' || a === '--json'));
function option(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const valueFlags = new Set(['-o', '--top', '--kind', '--mod']);
const ARTIFACTS = new Set(['report.json', 'report.md', 'trace.json.gz', 'samples.collapsed', 'samples.jfr']);
const positional = argv.filter((a, i) => !flags.has(a) && !valueFlags.has(a) && !valueFlags.has(argv[i - 1]));
const [command, ...rest] = positional;

const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usage(code = 2) {
  const lines = readFileSync(new URL(import.meta.url), 'utf8').split('\n');
  const end = lines.findIndex((l) => l.startsWith(' */'));
  console.error(lines.slice(2, end).map((l) => l.replace(/^ \*\s?/, '')).join('\n'));
  process.exit(code);
}

async function request(method, urlPath, body) {
  if (!apiKey) throw new Error('missing YGG_API_KEY (or API_KEYS)');
  return fetch(`${base}${urlPath}`, {
    method,
    headers: { [apiKeyHeader]: apiKey, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** JSON call. Returns null on 404 when `allow404`, throws on any other error status. */
async function api(method, urlPath, body, allow404 = false) {
  const res = await request(method, urlPath, body);
  const text = await res.text();
  if (res.status === 404 && allow404) return null;
  if (!res.ok) {
    let msg = text.slice(0, 500);
    try {
      msg = JSON.parse(text).error?.message ?? msg;
    } catch {
      // not JSON
    }
    throw new Error(`${method} ${urlPath}: HTTP ${res.status}: ${msg}`);
  }
  return text ? JSON.parse(text) : {};
}

const n3 = (v) => (typeof v === 'number' ? v.toFixed(3) : '-');
const pct = (v) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : '-');
const kb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`);

function triggerLine(t) {
  if (!t) return '-';
  const skipped = t.suppressed ? `, ${t.suppressed} skipped by the rate limit (max ${n3(t.suppressedMaxMs)} ms)` : '';
  return (
    `tick ${t.tick} took ${n3(t.tickMs)} ms (threshold ${t.thresholdMs} ms) at ${t.at ?? '-'}, ` +
    `window ${((t.preMs ?? 0) / 1000).toFixed(1)} s + ${((t.postMs ?? 0) / 1000).toFixed(1)} s, ` +
    `${t.spikesInWindow ?? '-'} spike tick(s) in it${skipped}${t.cutShort ? `, cut short: ${t.cutShort}` : ''}`
  );
}

function printSummary(data) {
  const r = data.report ?? {};
  const m = r.mspt ?? {};
  console.log(`${r.kind === 'spike' ? 'spike dump' : 'capture'} ${data.captureId} on ${data.instanceKey}`);
  if (r.trigger) console.log(`  spike: ${triggerLine(r.trigger)}`);
  console.log(
    `  level ${r.level ?? '-'}  sampler ${r.sampler ?? '-'}  duration ${((r.durationMs ?? 0) / 1000).toFixed(1)} s  ` +
      `ticks ${r.tickCount ?? '-'}  stop ${r.stopReason ?? '-'}  truncated ${r.truncated ? 'YES' : 'no'}`,
  );
  console.log(`  MSPT p50 ${n3(m.p50)}  p95 ${n3(m.p95)}  p99 ${n3(m.p99)}  max ${n3(m.max)}  avg ${n3(m.avg)}  TPS ${n3(r.tps)}`);
  console.log(`  artifacts: ${data.artifacts.map((a) => `${a.artifact} (${kb(a.size)})`).join(', ')}`);
  for (const note of r.notes ?? []) console.log(`  note: ${note}`);
  const hot = (r.hotspots ?? []).slice(0, 15);
  if (hot.length > 0) {
    console.log(`\ntop hotspots of ${r.hotspotsTotal ?? hot.length} (ms/tick self, p95, share, count/tick):`);
    for (const h of hot) {
      const top = h.topMethods?.[0];
      const pos = h.topPositions?.[0];
      console.log(
        `  ${n3(h.msPerTick).padStart(8)} ${n3(h.msPerTickP95).padStart(8)} ${pct(h.share).padStart(6)} ${n3(h.countPerTick).padStart(9)}  ` +
          `${h.id}  [${h.mod ?? '-'}]` +
          (top ? `  hot: ${top.frame} (${pct(top.share)})` : '') +
          (pos ? `  at ${pos.dim} ${pos.x},${pos.y},${pos.z}` : ''),
      );
    }
  }
  const mods = (r.mods ?? []).slice(0, 10);
  if (mods.length > 0) {
    console.log('\nmods (ms/tick self, share):');
    for (const md of mods) console.log(`  ${n3(md.msPerTick).padStart(8)} ${pct(md.share).padStart(6)}  ${md.mod}${md.jar ? `  (${md.jar})` : ''}`);
  }
  const worst = (r.worstTicks ?? []).slice(0, 5);
  if (worst.length > 0) {
    console.log('\nworst ticks:');
    for (const t of worst) {
      const zones = (t.zones ?? []).slice(0, 3).map((z) => `${z.name} ${n3(z.selfMs)}`).join(', ');
      console.log(`  tick ${t.tick} ${n3(t.ms)} ms  ${zones}`);
    }
  }
}

async function capture() {
  const [server, seconds, level, sampler] = rest;
  if (!server) usage();
  const body = {
    ...(seconds ? { seconds: Number(seconds) } : {}),
    ...(level ? { level: level.toLowerCase() } : {}),
    ...(sampler ? { sampler } : {}),
    ...(flags.has('--confirm') ? { confirm: true } : {}),
  };
  const created = (await api('POST', `/v1/biforesting/${enc(server)}/profiles`, body)).data;
  console.error(`queued op ${created.opId} (${created.state}) ${JSON.stringify(created.params)}`);
  if (!flags.has('--wait')) {
    console.log(created.opId);
    return;
  }

  const opDeadline = Date.now() + created.params.seconds * 1000 + 5 * 60_000;
  let op;
  let lastState = created.state;
  for (;;) {
    op = (await api('GET', `/v1/biforesting/ops/${created.opId}`)).data;
    if (op.state !== lastState) {
      console.error(`op ${op.state}`);
      lastState = op.state;
    }
    if (TERMINAL.has(op.state)) break;
    if (Date.now() > opDeadline) throw new Error(`op ${created.opId} is still ${op.state}; stopped waiting`);
    await sleep(1000);
  }
  if (op.state !== 'completed') {
    console.error(`capture ${op.state}: ${op.result?.error ?? 'no reason given'}${op.result?.code ? ` (${op.result.code})` : ''}`);
    process.exit(1);
  }

  // The mod uploads after it reports the result. Wait for report.json.
  let captureId = op.result?.data?.captureId;
  const reportDeadline = Date.now() + 180_000;
  for (;;) {
    if (!captureId) {
      const list = (await api('GET', `/v1/biforesting/${enc(server)}/profiles`)).data;
      captureId = list.captures.find((c) => c.opId === created.opId)?.captureId;
    }
    if (captureId) {
      const got = await api('GET', `/v1/biforesting/${enc(server)}/profiles/${enc(captureId)}`, undefined, true);
      if (got?.data?.report) {
        printSummary(got.data);
        return;
      }
    }
    if (Date.now() > reportDeadline) {
      throw new Error(`op completed, but report.json for ${captureId ?? `op ${created.opId}`} did not arrive in 180 s`);
    }
    await sleep(1000);
  }
}

async function list() {
  const [server] = rest;
  if (!server) usage();
  const kind = option('--kind');
  const data = (await api('GET', `/v1/biforesting/${enc(server)}/profiles${kind ? `?kind=${enc(kind)}` : ''}`)).data;
  if (flags.has('--json')) return console.log(JSON.stringify(data, null, 2));
  console.log(`${data.count} capture(s) on ${data.instanceKey}`);
  for (const c of data.captures) {
    const summary = c.hasReport
      ? `${c.level ?? '-'} ${c.sampler ?? '-'} ${((c.durationMs ?? 0) / 1000).toFixed(1)}s p95 ${n3(c.mspt?.p95)} max ${n3(c.mspt?.max)} tps ${n3(c.tps)}${c.truncated ? ' TRUNCATED' : ''}`
      : 'no report yet';
    console.log(
      `  ${c.captureId}  ${c.kind ?? 'capture'}  ${new Date(c.createdAt).toISOString()}  ${summary}  [${c.artifacts.join(', ')}]  op ${c.opId ?? '-'}`,
    );
  }
}

async function spikes() {
  const [server] = rest;
  if (!server) usage();
  const data = (await api('GET', `/v1/biforesting/${enc(server)}/profiles?kind=spike`)).data;
  if (flags.has('--json')) return console.log(JSON.stringify(data, null, 2));
  console.log(`${data.count} spike dump(s) on ${data.instanceKey}`);
  for (const c of data.captures) {
    console.log(`  ${c.captureId}  ${new Date(c.createdAt).toISOString()}  [${c.artifacts.join(', ') || 'report only, use fetch'}]`);
    console.log(`    ${triggerLine(c.trigger)}`);
    if (c.hasReport) {
      console.log(`    MSPT p50 ${n3(c.mspt?.p50)} p95 ${n3(c.mspt?.p95)} max ${n3(c.mspt?.max)}, ${c.tickCount ?? '-'} ticks`);
    }
  }
}

async function fetchCapture() {
  const [server, captureId, ...artifacts] = rest;
  if (!server || !captureId) usage();
  for (const a of artifacts) if (!ARTIFACTS.has(a)) throw new Error(`unknown artifact ${a} (known: ${[...ARTIFACTS].join(', ')})`);
  const body = {
    type: 'profile_fetch',
    params: { captureId, ...(artifacts.length > 0 ? { artifacts } : {}) },
  };
  const created = (await api('POST', `/v1/biforesting/${enc(server)}/ops`, body)).data;
  const opId = created.opId ?? created._id ?? created.op?._id;
  console.error(`queued profile_fetch op ${opId} (${created.state ?? created.op?.state ?? '?'})`);
  if (!flags.has('--wait')) {
    console.log(opId);
    return;
  }
  const deadline = Date.now() + 6 * 60_000;
  let op;
  for (;;) {
    op = (await api('GET', `/v1/biforesting/ops/${opId}`)).data;
    if (TERMINAL.has(op.state)) break;
    if (Date.now() > deadline) throw new Error(`op ${opId} is still ${op.state}; stopped waiting`);
    await sleep(1000);
  }
  if (op.state !== 'completed') {
    console.error(`fetch ${op.state}: ${op.result?.error ?? 'no reason given'}${op.result?.code ? ` (${op.result.code})` : ''}`);
    process.exit(1);
  }
  const r = op.result?.data ?? {};
  console.log(`fetched ${captureId}: uploaded [${(r.uploaded ?? []).join(', ')}], already stored [${(r.alreadyStored ?? []).join(', ')}], missing [${(r.missing ?? []).join(', ')}]`);
  for (const e of r.uploadErrors ?? []) console.log(`  upload error: ${e}`);
}

async function report() {
  const [server, captureId] = rest;
  if (!server || !captureId) usage();
  const data = (await api('GET', `/v1/biforesting/${enc(server)}/profiles/${enc(captureId)}`)).data;
  if (flags.has('--json')) return console.log(JSON.stringify(data.report, null, 2));
  if (!data.report) {
    console.log(`capture ${captureId} has no report.json yet. Stored: ${data.artifacts.map((a) => a.artifact).join(', ')}`);
    return;
  }
  printSummary(data);
  if (data.reportSource === 'summary') console.log('\n(stored summary only: fetch report.json for the full report)');
}

async function get() {
  const [server, captureId, artifact] = rest;
  if (!server || !captureId || !artifact) usage();
  const out = option('-o') ?? `${captureId}-${artifact}`;
  const res = await request('GET', `/v1/biforesting/${enc(server)}/profiles/${enc(captureId)}/${enc(artifact)}`);
  if (!res.ok) throw new Error(`GET ${artifact}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const hash = createHash('sha256');
  let bytes = 0;
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), tap, createWriteStream(out));
  const got = hash.digest('hex');
  const want = res.headers.get('x-bf-content-sha256');
  if (want && want !== got) throw new Error(`sha256 mismatch on ${out}: got ${got}, server says ${want}`);
  console.log(`${out} (${bytes} bytes, sha256 ${got}${want ? ' verified' : ''})`);
}

async function hotspots() {
  const q = new URLSearchParams();
  q.set('top', option('--top') ?? '50');
  if (option('--kind')) q.set('kind', option('--kind'));
  if (option('--mod')) q.set('mod', option('--mod'));
  const data = (await api('GET', `/v1/biforesting/profiles/hotspots?${q}`)).data;
  if (flags.has('--json')) return console.log(JSON.stringify(data, null, 2));
  console.log(`${data.count} hotspot(s), each server's newest report (ms/tick self, share):`);
  for (const h of data.hotspots) {
    const top = h.topMethods?.[0];
    console.log(
      `  ${n3(h.msPerTick).padStart(8)} ${pct(h.share).padStart(6)}  ${h.server}  ${h.id}  [${h.mod ?? '-'}]  ${h.captureId}` +
        (top ? `  hot: ${top.frame}` : ''),
    );
  }
}

async function perfetto() {
  const [server, captureId] = rest;
  if (!server || !captureId) usage();
  const data = (await api('POST', `/v1/biforesting/${enc(server)}/profiles/${enc(captureId)}/perfetto-link`)).data;
  console.log(`${base}${data.path}`);
  console.error(`link expires ${data.expiresAt}`);
}

function toTracy() {
  const [input, output] = rest;
  if (!input || !output) usage();
  const raw = readFileSync(input);
  const gz = raw[0] === 0x1f && raw[1] === 0x8b;
  const json = gz ? path.join(tmpdir(), `bfprof-${process.pid}-${Date.now()}.json`) : input;
  if (gz) writeFileSync(json, gunzipSync(raw));
  try {
    const run = spawnSync(TRACY_IMPORT, [json, output], { stdio: 'inherit' });
    if (run.error) throw new Error(`cannot run ${TRACY_IMPORT}: ${run.error.message} (set TRACY_IMPORT_CHROME)`);
    if (run.status !== 0) throw new Error(`tracy-import-chrome exited with ${run.status}`);
  } finally {
    if (gz) rmSync(json, { force: true });
  }
  console.log(output);
}

const commands = { capture, list, spikes, fetch: fetchCapture, report, get, hotspots, perfetto, 'to-tracy': toTracy };
const run = commands[command];
if (!run) usage(command ? 2 : 0);
try {
  await run();
} catch (err) {
  console.error(`bfprof: ${err.message}`);
  process.exit(1);
}
