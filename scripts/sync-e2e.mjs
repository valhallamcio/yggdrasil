#!/usr/bin/env node
/**
 * Player sync end to end on one machine (bifrost-lib `docs/invariants/player-sync.md` 3.3-3.7, 5-7).
 * No Minecraft server runs. Two fake mods (`scripts/fake-mod.mjs --sync`) stand in for the two
 * instances of group `evol`.
 *
 *   node scripts/sync-e2e.mjs > /tmp/sync-e2e.log 2>&1; echo e2e=$?
 *
 * It starts mongodb-memory-server on 127.0.0.1:27117, seeds `bifrost.servers` (A and B in group
 * `evol`, C ungrouped), starts Yggdrasil from this checkout on 127.0.0.1:3123 (`node --import tsx
 * src/main.ts`), starts fake mods A and B, grants the policy and runs scenarios a to y against the
 * REST API (the dupe audit l runs last). Each scenario prints one PASS or FAIL line. Exit 0 only
 * when all pass. Every process it started stops at the end. Logs: /tmp/sync-e2e-ygg.log,
 * /tmp/sync-e2e-fake-A.log, /tmp/sync-e2e-fake-B.log.
 *
 * The quest scenarios u to y (phase6 DESIGN 4 and 7) use their own group `qst` with three fake mods
 * Q1 to Q3 (logs /tmp/sync-e2e-fake-Q<n>.log). The first of them starts the fakes and sets the
 * group live, so the evol scenarios and the dupe audit never see them.
 *
 * The PSK comes from BIFORESTING_PSK, else from ../../bifrost-lib/.env next to this checkout.
 * A run takes about 10 minutes: scenarios d and n wait out the 120 s exec timeout of an op with no result.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';

const ROOT = resolve(new URL('.', import.meta.url).pathname, '..');
const YGG_PORT = 3123;
const MONGO_PORT = 27117;
const BASE = `http://127.0.0.1:${YGG_PORT}`;
const DB_NAME = 'yggdrasil_e2e';
const API_KEY = 'sync-e2e-api-key';
const GROUP = 'evol';
const A = 'aaaa0001';
const B = 'bbbb0002';
const C = 'cccc0003';
const BP = 'sophisticatedbackpacks';
const FP = createHash('sha256').update('sync-e2e fingerprint').digest('hex');
const FP_OTHER = createHash('sha256').update('sync-e2e other pack version').digest('hex');
const QGROUP = 'qst';
const Q1 = 'qqqq0001';
const Q2 = 'qqqq0002';
const Q3 = 'qqqq0003';
const CONTROL = { [A]: 3201, [B]: 3202, [Q1]: 3203, [Q2]: 3204, [Q3]: 3205 };
const LOG_TAG = { [A]: 'A', [B]: 'B', [Q1]: 'Q1', [Q2]: 'Q2', [Q3]: 'Q3' };
const FEATURES = ['play_transport', 'ops', 'presence', 'player_sync'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[e2e +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

function readPsk() {
  if (process.env.BIFORESTING_PSK) return process.env.BIFORESTING_PSK;
  const file = resolve(ROOT, '../../bifrost-lib/.env');
  if (existsSync(file)) {
    const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('BIFORESTING_PSK='));
    if (line) return line.slice('BIFORESTING_PSK='.length).trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('no PSK: set BIFORESTING_PSK or provide bifrost-lib/.env');
}
const PSK = readPsk();

// ── assertions ───────────────────────────────────────────────────────────────

class Check extends Error {}
function assert(cond, msg) {
  if (!cond) throw new Check(msg);
}
function eq(actual, expected, msg) {
  if (!isDeepStrictEqual(actual, expected)) throw new Check(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
async function waitFor(desc, fn, timeoutMs = 20_000, intervalMs = 250) {
  const until = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = `error: ${e.message}`;
    }
    if (Date.now() > until) throw new Check(`timed out after ${timeoutMs} ms waiting for ${desc} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
    await sleep(intervalMs);
  }
}

// ── processes ────────────────────────────────────────────────────────────────

const children = new Set();
let mem = null;
let mongo = null;
let ygg = null;

function track(child, name) {
  children.add(child);
  child.on('exit', (code, signal) => {
    children.delete(child);
    log(`${name} exited (code ${code}, signal ${signal})`);
  });
  return child;
}

function startYggdrasil() {
  const out = openSync('/tmp/sync-e2e-ygg.log', 'a');
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'development',
    PORT: String(YGG_PORT),
    HOST: '127.0.0.1',
    MONGODB_URI: `mongodb://127.0.0.1:${MONGO_PORT}`,
    MONGODB_DB_NAME: DB_NAME,
    JWT_SECRET: 'sync-e2e-jwt-secret-0123456789abcdef',
    API_KEYS: API_KEY,
    LOG_LEVEL: 'info',
    LOG_PRETTY: 'false',
    RATE_LIMIT_MAX: '100000',
    PLUGIN_DISCORD: 'false',
    PLUGIN_WEBSOCKET: 'true',
    PLUGIN_BIFORESTING_LINK: 'true',
    BIFORESTING_PSK: PSK,
    BIFORESTING_PUBLIC_URL: BASE,
  };
  ygg = track(spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { cwd: ROOT, env, stdio: ['ignore', out, out] }), 'yggdrasil');
  return ygg;
}

async function waitHealthy() {
  await waitFor('yggdrasil /health', async () => (await fetch(`${BASE}/health`)).ok, 90_000, 500);
}

async function stopYggdrasil(signal = 'SIGTERM') {
  if (!ygg || ygg.exitCode !== null || ygg.signalCode !== null) return;
  const done = new Promise((r) => ygg.once('exit', r));
  ygg.kill(signal);
  await Promise.race([done, sleep(10_000)]);
  if (ygg.exitCode === null && ygg.signalCode === null) {
    ygg.kill('SIGKILL');
    await done;
  }
}

function startFake(serverId) {
  const out = openSync(`/tmp/sync-e2e-fake-${LOG_TAG[serverId]}.log`, 'a');
  const args = [resolve(ROOT, 'scripts/fake-mod.mjs'), '127.0.0.1', String(YGG_PORT), serverId, '--sync', '--fp', FP, '--control-port', String(CONTROL[serverId])];
  return track(spawn(process.execPath, args, { cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, BIFORESTING_PSK: PSK }, stdio: ['ignore', out, out] }), `fake ${serverId}`);
}

async function cleanup() {
  for (const c of [...children]) c.kill('SIGTERM');
  const until = Date.now() + 8000;
  while (children.size > 0 && Date.now() < until) await sleep(100);
  for (const c of [...children]) c.kill('SIGKILL');
  while (children.size > 0) await sleep(100);
  if (mongo) await mongo.close().catch(() => undefined);
  if (mem) await mem.stop().catch(() => undefined);
}

// ── REST and control helpers ─────────────────────────────────────────────────

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'x-actor': 'sync-e2e' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}
const syncPath = (p = '') => `/v1/biforesting/sync/${GROUP}${p}`;
const playerPath = (uuid, p = '', group = GROUP) => `/v1/biforesting/sync/${group}/players/${uuid}${p}`;

async function ledger(uuid, group = GROUP) {
  const r = await api('GET', playerPath(uuid, '', group));
  if (r.status === 404) return null;
  assert(r.status === 200, `GET ledger ${uuid}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}

async function startMove(uuid, from, to, name) {
  return api('POST', playerPath(uuid, '/moves'), { from, to, name, reason: 'sync-e2e' });
}

async function getMove(uuid, moveId, query = '', group = GROUP) {
  const r = await api('GET', playerPath(uuid, `/moves/${moveId}${query}`, group));
  assert(r.status === 200, `GET move ${moveId}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}

/** Long-polls a move until it has an outcome and the runner closed it. */
async function waitOutcome(uuid, moveId, timeoutMs = 60_000, group = GROUP) {
  const until = Date.now() + timeoutMs;
  let move;
  for (;;) {
    try {
      move = await getMove(uuid, moveId, '?waitMs=10000', group);
      if (move.outcome !== null) return move;
    } catch (e) {
      if (!(e instanceof TypeError) && !(e instanceof Check)) throw e;
      await sleep(500); // yggdrasil restarting
    }
    if (Date.now() > until) throw new Check(`move ${moveId} has no outcome after ${timeoutMs} ms (step ${move?.step})`);
  }
}

/** The move doc as the runner wrote it, steps included. */
async function moveDoc(moveId) {
  return mongo.db(DB_NAME).collection('biforesting_sync_moves').findOne({ _id: moveId });
}
async function waitMoveDone(moveId, timeoutMs = 30_000) {
  return waitFor(`move ${moveId} at step done`, async () => {
    const d = await moveDoc(moveId);
    return d?.step === 'done' ? d : null;
  }, timeoutMs);
}

function fakeOf(serverId) {
  const base = `http://127.0.0.1:${CONTROL[serverId]}`;
  const post = async (name, body = {}) => {
    const res = await fetch(`${base}/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
  };
  return {
    id: serverId,
    state: async () => (await fetch(`${base}/state`)).json(),
    seed: (b) => post('seed', b),
    join: (uuid, name) => post('join', { uuid, name }),
    quit: (uuid) => post('quit', { uuid }),
    fault: (b) => post('fault', b),
    disconnect: (b = {}) => post('disconnect', b),
    reconnect: (b = {}) => post('reconnect', b),
    restore: (b) => post('restore', b),
    open: (h, key) => post('open', { h, key }),
    quests: (b) => post('quests', b),
  };
}
const fa = fakeOf(A);
const fb = fakeOf(B);
const fq1 = fakeOf(Q1);
const fq2 = fakeOf(Q2);
const fq3 = fakeOf(Q3);

const stampOf = (dat) => dat?.NeoForgeData?.PlayerPersisted?.biforesting_sync ?? null;

async function waitRegistered(f, granted = true) {
  return waitFor(`fake ${f.id} registered${granted ? ' with player_sync' : ''}`, async () => {
    const s = await f.state();
    return s.registered && (!granted || (s.granted & 0x80000) !== 0) ? s : null;
  }, 60_000);
}

async function joinQuit(f, uuid, name, group = GROUP) {
  const j = await f.join(uuid, name);
  assert(j.ok, `join ${name} on ${f.id} refused: ${JSON.stringify(j)}`);
  await waitFor(`ledger lastSeen join of ${name} on ${f.id}`, async () => {
    const d = await ledger(uuid, group);
    return d?.lastSeen?.serverId === f.id && d.lastSeen.event === 'join' ? d : null;
  });
  const q = await f.quit(uuid);
  assert(q.ok, `quit ${name} on ${f.id}: ${JSON.stringify(q)}`);
  return waitFor(`ledger lastSeen quit of ${name} on ${f.id}`, async () => {
    const d = await ledger(uuid, group);
    return d?.lastSeen?.serverId === f.id && d.lastSeen.event === 'quit' ? d : null;
  });
}

// ── test data ────────────────────────────────────────────────────────────────

let seq = 0x100;
const players = new Map(); // uuid → name
function newPlayer(tag) {
  const uuid = `00000000-0000-4000-8000-${(seq++).toString(16).padStart(12, '0')}`;
  const name = `E2e_${tag}`;
  players.set(uuid, name);
  return { uuid, name };
}
const stack = (slot, id, count = 1, components) => ({ Slot: slot, id, count, ...(components ? { components } : {}) });
const backpack = (slot, key) => stack(slot, `${BP}:backpack`, 1, { 'sophisticatedcore:storage_uuid': key, 'minecraft:custom_name': 'Backpack' });
const dat = (items, extra = {}) => ({
  Inventory: items,
  EnderItems: [stack(0, 'minecraft:ender_pearl', 4)],
  XpLevel: 12,
  XpTotal: 345,
  Health: 18,
  Pos: [10.5, 64, -3.5],
  Dimension: 'minecraft:overworld',
  ...extra,
});
const bpKey = () => `bbbbbbbb-0000-4000-8000-${(seq++).toString(16).padStart(12, '0')}`;

/** A player with a dat (and a backpack when asked) on `f`, plus a ledger doc from a join and a quit. */
async function setupPlayer(tag, { f = fa, withBackpack = false, items = null, also = null } = {}) {
  const p = newPlayer(tag);
  const inv = items ?? [stack(0, 'minecraft:diamond', 7), stack(1, 'minecraft:iron_ingot', 30)];
  const worldData = {};
  if (withBackpack) {
    p.bp = bpKey();
    inv.push(backpack(2, p.bp));
    worldData[BP] = { [p.bp]: { items: [stack(0, 'minecraft:gold_ingot', 32), stack(1, 'minecraft:emerald', 3)] } };
  }
  p.dat = dat(inv);
  await f.seed({ uuid: p.uuid, name: p.name, dat: p.dat, worldData, playerData: { puffish_skills: { points: 3, skills: ['mining'] } } });
  if (also) await also.seed({ uuid: p.uuid, name: p.name, dat: dat([stack(0, 'minecraft:stick', 1)]) });
  p.joined = await joinQuit(f, p.uuid, p.name);
  return p;
}

async function resetFaults() {
  await fa.fault({ reset: true });
  await fb.fault({ reset: true });
}

/** A committed move from A to B: ledger, both fakes and the world-data lock agree. */
async function checkCommitted(p, moveId, v, from = fa, to = fb) {
  const d = await ledger(p.uuid);
  eq([d.state, d.owner, d.version, d.move], ['online', to.id, v, null], `${p.name} ledger after commit`);
  await waitMoveDone(moveId);
  const sa = await from.state();
  const sb = await to.state();
  eq(sa.away[p.uuid] && [sa.away[p.uuid].v, sa.away[p.uuid].m, sa.away[p.uuid].to], [v, moveId, to.id], `${p.name} away on the source`);
  assert(!sa.moving[p.uuid], `${p.name} still moving on the source`);
  const st = stampOf(sb.dats[p.uuid]);
  eq(st, { g: GROUP, v, m: moveId }, `${p.name} stamp on the target`);
  eq(sb.dats[p.uuid].Inventory, p.dat.Inventory, `${p.name} inventory on the target`);
  eq(sb.dats[p.uuid].XpLevel, p.dat.XpLevel, `${p.name} XpLevel on the target`);
  assert(!sb.away[p.uuid], `${p.name} away on the target`);
  if (p.bp) {
    eq(sa.locks[`${BP}:${p.bp}`]?.state, 'tombstone', `${p.name} backpack lock on the source`);
    assert(!sa.worldData[BP][p.bp], `${p.name} backpack record still on the source`);
    assert(!!sb.worldData[BP][p.bp], `${p.name} backpack record missing on the target`);
    assert(!sb.locks[`${BP}:${p.bp}`], `${p.name} backpack lock on the target`);
    const wd = await mongo.db(DB_NAME).collection('biforesting_sync_worlddata').findOne({ _id: `${GROUP}:${BP}:${p.bp}` });
    eq(wd && [wd.state, wd.owner, wd.moveId], ['owned', to.id, null], `${p.name} biforesting_sync_worlddata`);
  }
}

// ── quest progress helpers (group qst) ───────────────────────────────────────

const ctx = {};
const qPath = (uuid, p = '') => playerPath(uuid, `/quests${p}`, QGROUP);

/** Starts fakes Q1 to Q3 once, grants the policy and sets group qst live with no cooldown. */
async function ensureQuestGroup() {
  if (ctx.questGroup) return;
  for (const s of [Q1, Q2, Q3]) startFake(s);
  for (const f of [fq1, fq2, fq3]) await waitRegistered(f, false);
  for (const s of [Q1, Q2, Q3]) {
    const r = await api('PUT', `/v1/biforesting/${s}/policy`, { features: FEATURES });
    assert(r.status === 200 && r.body.data?.reAcked === true, `policy ${s}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  }
  for (const f of [fq1, fq2, fq3]) await waitRegistered(f);
  const g = await api('PUT', `/v1/biforesting/sync/${QGROUP}`, { mode: 'live', cooldownMs: 0 });
  assert(g.status === 200, `group ${QGROUP} live: HTTP ${g.status} ${JSON.stringify(g.body)}`);
  ctx.questGroup = true;
}

let qseq = 0x900;
/** A player with a .dat on `f` and a ledger doc in group qst. The evol dupe audit never sees it. */
async function questPlayer(tag, f = fq1) {
  const p = { uuid: `00000000-0000-4000-9000-${(qseq++).toString(16).padStart(12, '0')}`, name: `Q_${tag}` };
  await f.seed({ uuid: p.uuid, name: p.name, dat: dat([stack(0, 'minecraft:book', 1)]) });
  await joinQuit(f, p.uuid, p.name, QGROUP);
  return p;
}
const newTeamId = () => `${(qseq++).toString(16).padStart(8, '0')}-0000-4000-a000-000000000000`;

async function questLease(uuid) {
  const doc = await mongo.db(DB_NAME).collection('biforesting_sync_players').findOne({ _id: `${QGROUP}:${uuid}` });
  return doc?.lease ?? null;
}

async function preActionSnaps(uuid, atLeast) {
  return waitFor(`${atLeast} pre_action snapshots of ${uuid}`, async () => {
    const r = await api('GET', playerPath(uuid, '/snapshots?kind=pre_action', QGROUP));
    return r.body.data?.count >= atLeast ? r.body.data.snapshots : null;
  });
}

// ── scenarios ────────────────────────────────────────────────────────────────


const scenarios = [
  ['a', 'shadow mode: ledger, shadow syncsnap, shadow-move verdicts', async () => {
    eq((await api('PUT', syncPath(), { mode: 'shadow' })).status, 200, 'PUT mode shadow');
    const p = newPlayer('shadow');
    ctx.shadow = p;
    p.dat = dat([stack(0, 'minecraft:diamond', 3)]);
    await fa.seed({ uuid: p.uuid, name: p.name, dat: p.dat });
    const j = await fa.join(p.uuid, p.name);
    assert(j.ok, 'join refused');
    const doc = await waitFor('shadow ledger doc', () => ledger(p.uuid));
    eq([doc.owner, doc.version, doc.state, doc.shadow], [A, 0, 'online', true], 'shadow ledger doc');
    await fa.quit(p.uuid);
    const snaps = async (n) =>
      waitFor(`${n} shadow snapshots`, async () => {
        const r = await api('GET', playerPath(p.uuid, '/snapshots?kind=shadow'));
        return r.body?.data?.count >= n ? r.body.data.snapshots : null;
      });
    const first = (await snaps(1))[0];
    eq([first.kind, first.serverId, first.v, first.fp], ['shadow', A, 0, FP], 'shadow snapshot meta');
    const full = await api('GET', `/v1/biforesting/sync/snapshots/${encodeURIComponent(first._id)}`);
    const root = JSON.parse(gunzipSync(Buffer.from(full.body.data.gzBase64, 'base64')).toString('utf8'));
    eq(root.carried.Inventory, p.dat.Inventory, 'shadow blob carried Inventory');
    assert(!('Pos' in root.carried), 'shadow blob carries Pos');

    let v = await api('POST', playerPath(p.uuid, '/shadow-move'), { from: A, to: B });
    eq([v.status, v.body.data?.verdict, v.body.data?.reasons], [200, 'ok', []], 'clean shadow-move');

    await fa.seed({ uuid: p.uuid, dat: dat([stack(0, 'minecraft:diamond', 3), stack(5, 'dankstorage:dank_1', 1)]) });
    await joinQuit(fa, p.uuid, p.name);
    await snaps(2);
    v = await api('POST', playerPath(p.uuid, '/shadow-move'), { from: A, to: B });
    const blocked = v.body.data?.reasons?.find((r) => r.code === 'blocked_items');
    eq(v.body.data?.verdict, 'blocked', 'shadow-move with a dank');
    eq(blocked?.blocked?.map((b) => b.id), ['dankstorage:dank_1'], 'blocked_items reason');

    await fa.seed({ uuid: p.uuid, dat: p.dat });
    await joinQuit(fa, p.uuid, p.name);
    await snaps(3);
    await fb.reconnect({ fp: FP_OTHER });
    await waitFor('B on the other fingerprint', async () => {
      const g = await api('GET', syncPath());
      return g.body.data?.instances?.find((i) => i.serverId === B)?.fp === FP_OTHER;
    });
    v = await api('POST', playerPath(p.uuid, '/shadow-move'), { from: A, to: B });
    eq([v.body.data?.verdict, v.body.data?.reasons?.map((r) => r.code)], ['blocked', ['fingerprint_mismatch']], 'shadow-move across fingerprints');

    await fb.reconnect({ fp: FP });
    await waitFor('both fingerprints match', async () => {
      const g = await api('GET', syncPath());
      return g.body.data?.instances?.length === 2 && g.body.data.instances.every((i) => i.live && i.fp === FP && i.fpMatch);
    });
    const ops = [...(await fa.state()).opsSeen, ...(await fb.state()).opsSeen];
    eq(ops.length, 0, 'sync ops sent in shadow mode');
  }],

  ['i', 'disown reconcile on mode change to live', async () => {
    const p = await setupPlayer('reconcile', { also: fb });
    ctx.reconcile = p;
    eq((await api('PUT', syncPath(), { mode: 'live' })).status, 200, 'PUT mode live');
    await waitFor('B marks the A-owned players away', async () => {
      const s = await fb.state();
      return s.away[p.uuid] && s.away[ctx.shadow.uuid];
    });
    const d = await waitFor('ledger disowned lists B', async () => {
      const x = await ledger(p.uuid);
      return x?.disowned?.includes(B) ? x : null;
    });
    eq([d.owner, d.version, d.state], [A, 0, 'online'], 'ledger after reconcile');
    const sb = await fb.state();
    eq([sb.away[p.uuid].v, sb.away[p.uuid].to, sb.away[p.uuid].toLabel], [0, A, 'Instance 1'], 'away entry on B');
    const r = await fb.join(p.uuid, p.name);
    eq([r.ok, r.refused], [false, 'away'], 'login on B after the disown');
    assert((await fa.state()).opsSeen.every((o) => o.type !== 'sync_disown'), 'A got a disown although nobody lives on B');
  }],

  ['b', 'live happy path', async () => {
    const p = newPlayer('happy');
    ctx.happy = p;
    p.bp = bpKey();
    // A component this large makes the sync_apply DOWN message span several 24 KB chunks.
    const big = createHash('sha512').update('x').digest('hex');
    let filler = '';
    for (let i = 0; filler.length < 80_000; i++) filler += createHash('sha256').update(`${big}${i}`).digest('hex');
    p.dat = dat([
      stack(0, 'minecraft:diamond_sword', 1, { 'minecraft:custom_data': { e2e: filler } }),
      stack(1, 'minecraft:diamond', 64),
      backpack(2, p.bp),
    ]);
    await fa.seed({
      uuid: p.uuid,
      name: p.name,
      dat: p.dat,
      worldData: { [BP]: { [p.bp]: { items: [stack(0, 'minecraft:gold_ingot', 32)] } } },
      playerData: { puffish_skills: { points: 9, skills: ['combat'] } },
    });
    const j = await fa.join(p.uuid, p.name);
    assert(j.ok, 'join on A refused');
    await waitFor('live ledger doc', async () => (await ledger(p.uuid))?.owner === A);

    const res = await startMove(p.uuid, A, B, p.name);
    eq(res.status, 201, `POST move: ${JSON.stringify(res.body)}`);
    const move = res.body.data.move;
    eq([move.step, move.outcome, move.from, move.to, move.vFrom, move.vTo], ['prepare', null, A, B, 0, 1], 'move at 201');
    let polled = await getMove(p.uuid, move.id, '?waitMs=10000&step=prepare');
    // The target probe answer also wakes the poll (spec 7). When it lands before the prepare
    // result, the step still reads prepare, and the next poll waits for the step change.
    if (polled.step === 'prepare' && polled.targetHasCharacter !== null) polled = await getMove(p.uuid, move.id, '?waitMs=10000&step=prepare');
    eq(polled.step, 'wait_quit', 'long poll after prepare');
    assert(/Instance 2/.test(polled.message), `wait_quit message: ${polled.message}`);
    eq((await fa.state()).moving[p.uuid], move.id, 'moving mark on A');
    const refused = await fa.join(p.uuid, p.name);
    eq([refused.ok, refused.refused], [false, 'moving'], 'a second login on A while moving');

    await fa.quit(p.uuid);
    const done = await waitOutcome(p.uuid, move.id, 30_000);
    eq([done.outcome, done.code, done.owner, done.version], ['committed', null, B, 1], 'committed move');
    await checkCommitted(p, move.id, 1);
    const sb = await fb.state();
    eq(sb.playerData.puffish_skills[p.uuid], { points: 9, skills: ['combat'] }, 'puffish data on B');
    assert(sb.downChunked > 0, 'the sync_apply DOWN message was not chunked');
    assert(!('Pos' in sb.dats[p.uuid]), 'create mode wrote Pos on B');

    const list = await api('GET', playerPath(p.uuid, '/moves'));
    eq([list.body.data?.count, list.body.data?.moves?.[0]?.id, list.body.data?.moves?.[0]?.outcome], [1, move.id, 'committed'], 'GET moves');
    const startedAt = Date.now();
    const again = await getMove(p.uuid, move.id, '?waitMs=15000&step=prepare');
    assert(Date.now() - startedAt < 3000, `?step= long poll took ${Date.now() - startedAt} ms`);
    eq(again.outcome, 'committed', '?step= long poll answer');
    const snapR = await api('GET', playerPath(p.uuid, '/snapshots?kind=release'));
    eq(snapR.body.data?.snapshots?.map((s) => [s.v, s.serverId, s.moveId]), [[1, A, move.id]], 'release snapshot list');

    const a2 = await fa.join(p.uuid, p.name);
    eq([a2.ok, a2.refused], [false, 'away'], 'login on A after the move');
    const b2 = await fb.join(p.uuid, p.name);
    assert(b2.ok, 'login on B refused');
    await sleep(1500);
    assert(!(await fb.state()).kicks.some((k) => k.uuid === p.uuid), 'the detector kicked the owner on B');
    await fb.quit(p.uuid);
    ctx.happyMove = move.id;
  }],

  ['c', 'blocked at prepare, and blocked at release', async () => {
    const p = await setupPlayer('blocked', { items: [stack(0, 'minecraft:diamond', 2), stack(4, 'dankstorage:dank_3', 1)] });
    ctx.blocked = p;
    const res = await startMove(p.uuid, A, B, p.name);
    eq(res.status, 201, `POST move: ${JSON.stringify(res.body)}`);
    const done = await waitOutcome(p.uuid, res.body.data.move.id);
    eq([done.outcome, done.code], ['aborted', 'blocked'], 'blocked move');
    eq(done.blocked?.map((b) => b.id), ['dankstorage:dank_3'], 'blocked list');
    assert(done.message.includes('dankstorage:dank_3') && done.message.includes('Instance 1'), `message: ${done.message}`);
    await waitMoveDone(done.id);
    const d = await ledger(p.uuid);
    eq([d.state, d.owner, d.version, d.move], ['online', A, 0, null], 'ledger after a blocked prepare');
    const sa = await fa.state();
    assert(!sa.away[p.uuid] && !sa.moving[p.uuid] && !stampOf(sa.dats[p.uuid]), 'A marks after a blocked prepare');

    const q = await setupPlayer('blockedrel');
    ctx.blockedRelease = q;
    await fa.fault({ blockAt: { release: 1 } });
    const r2 = await startMove(q.uuid, A, B, q.name);
    eq(r2.status, 201, 'POST move 2');
    const done2 = await waitOutcome(q.uuid, r2.body.data.move.id, 30_000);
    eq([done2.outcome, done2.code, done2.blocked?.map((b) => b.id)], ['aborted', 'blocked', ['fake:fault_item']], 'blocked at release');
    const doc2 = await waitMoveDone(done2.id);
    assert(doc2.ops.abort, 'no sync_abort after a prepare that armed the move mark');
    const d2 = await ledger(q.uuid);
    eq([d2.state, d2.owner, d2.version], ['online', A, 0], 'ledger after a blocked release');
    const sa2 = await fa.state();
    assert(!sa2.away[q.uuid] && !sa2.moving[q.uuid] && !stampOf(sa2.dats[q.uuid]), 'A marks after a blocked release');
  }],

  ['d', 'release result dropped once: probe, retry, commit', async () => {
    const p = await setupPlayer('dropped', { withBackpack: true });
    ctx.dropped = p;
    await fa.fault({ dropResult: { sync_release: 1 } });
    const res = await startMove(p.uuid, A, B, p.name);
    eq(res.status, 201, 'POST move');
    const done = await waitOutcome(p.uuid, res.body.data.move.id, 300_000);
    eq([done.outcome, done.owner, done.version], ['committed', B, 1], 'move after a lost release result');
    await checkCommitted(p, done.id, 1);
    const doc = await moveDoc(done.id);
    assert(doc.ops.probe.length >= 1, 'no sync_probe');
    assert(doc.attempts.release === 2, `release attempts ${doc.attempts.release}`);
    const releases = (await fa.state()).opsSeen.filter((o) => o.type === 'sync_release' && o.moveId === done.id);
    eq(releases.length, 2, 'sync_release deliveries on A');
  }],

  ['e', 'apply answers fingerprint_mismatch: abort back to A', async () => {
    const p = await setupPlayer('fpmis', { withBackpack: true });
    ctx.fpmis = p;
    await fb.fault({ answerCode: { sync_apply: { code: 'fingerprint_mismatch', count: 1 } } });
    const res = await startMove(p.uuid, A, B, p.name);
    eq(res.status, 201, 'POST move');
    const done = await waitOutcome(p.uuid, res.body.data.move.id, 30_000);
    eq([done.outcome, done.code, done.owner, done.version], ['aborted', 'fingerprint_mismatch', A, 1], 'aborted move');
    eq(done.message, 'The instances run different pack versions right now. Try again after the update.', 'abort message');
    const doc = await waitMoveDone(done.id);
    assert(doc.ops.abort, 'no sync_abort op');
    const sa = await fa.state();
    assert(sa.opsSeen.some((o) => o.type === 'sync_abort' && o.moveId === done.id), 'A never got sync_abort');
    assert(!sa.away[p.uuid], 'away still set on A');
    assert(!sa.locks[`${BP}:${p.bp}`], `out lock still on A: ${JSON.stringify(sa.locks[`${BP}:${p.bp}`])}`);
    assert(!!sa.worldData[BP][p.bp], 'backpack record gone from A');
    eq(stampOf(sa.dats[p.uuid])?.v, 1, 'stamp on A');
    assert(!(await fb.state()).dats[p.uuid], 'B has a dat');
    const wd = await mongo.db(DB_NAME).collection('biforesting_sync_worlddata').findOne({ _id: `${GROUP}:${BP}:${p.bp}` });
    eq(wd && [wd.state, wd.owner], ['owned', A], 'world-data lock after abort');
    const j = await fa.join(p.uuid, p.name);
    assert(j.ok, `login on A after the abort refused: ${JSON.stringify(j)}`);
    await sleep(1500);
    assert(!(await fa.state()).kicks.some((k) => k.uuid === p.uuid), 'the detector kicked the owner on A');
    await fa.quit(p.uuid);
  }],

  ['h', 'detector: a join on B while A owns', async () => {
    const p = await setupPlayer('detector', { also: fb });
    ctx.detector = p;
    const before = await ledger(p.uuid);
    const j = await fb.join(p.uuid, p.name);
    assert(j.ok, `first login on B refused: ${JSON.stringify(j)}`);
    const sb = await waitFor('kick and away on B', async () => {
      const s = await fb.state();
      return s.kicks.some((k) => k.uuid === p.uuid) && s.away[p.uuid] ? s : null;
    });
    assert(!sb.online.includes(p.uuid), 'player still online on B');
    eq(sb.kicks.find((k) => k.uuid === p.uuid).message, 'This character is on Instance 1. Join again to go there.', 'kick message');
    const after = await waitFor('disowned lists B', async () => {
      const d = await ledger(p.uuid);
      return d?.disowned?.includes(B) ? d : null;
    });
    eq([after.owner, after.version, after.state], [before.owner, before.version, before.state], 'ledger after the detector');
    const r = await fb.join(p.uuid, p.name);
    eq([r.ok, r.refused], [false, 'away'], 'the next login on B');
  }],

  ['j', 'cooldown after a commit, none after an abort', async () => {
    const happy = ctx.happy;
    assert(happy, 'scenario b did not run');
    const r = await startMove(happy.uuid, B, A, happy.name);
    eq([r.status, r.body.error?.code], [409, 'cooldown'], 'move right after a commit');
    assert(/You can move again in \d+ minutes?\./.test(r.body.error?.message ?? ''), `cooldown message: ${r.body.error?.message}`);
    const p = ctx.blocked;
    assert(p, 'scenario c did not run');
    p.dat = dat([stack(0, 'minecraft:diamond', 2)]);
    await fa.seed({ uuid: p.uuid, dat: p.dat });
    const r2 = await startMove(p.uuid, A, B, p.name);
    eq(r2.status, 201, `move after an abort: ${JSON.stringify(r2.body)}`);
    const done = await waitOutcome(p.uuid, r2.body.data.move.id, 30_000);
    eq([done.outcome, done.owner, done.version], ['committed', B, 1], 'move after an abort');
    await checkCommitted(p, done.id, 1);
  }],

  ['k', 'two moves at once: one 201, one 409 moving', async () => {
    const p = await setupPlayer('race');
    ctx.race = p;
    const nm = await startMove(p.uuid, A, C, p.name);
    eq([nm.status, nm.body.error?.code], [409, 'not_member'], 'move to an ungrouped server');
    const both = await Promise.all([startMove(p.uuid, A, B, p.name), startMove(p.uuid, A, B, p.name)]);
    const statuses = both.map((x) => x.status).sort();
    eq(statuses, [201, 409], 'statuses');
    const lost = both.find((x) => x.status === 409);
    eq(lost.body.error?.code, 'moving', '409 code');
    const won = both.find((x) => x.status === 201).body.data.move;
    const done = await waitOutcome(p.uuid, won.id, 30_000);
    eq(done.outcome, 'committed', 'the winning move');
    await checkCommitted(p, won.id, 1);
    const list = await api('GET', playerPath(p.uuid, '/moves'));
    eq(list.body.data?.count, 1, 'moves stored for the player');
  }],

  ['f', 'B drops the link during apply: cancel, probe, reconnect', async () => {
    const outcomes = [];
    for (const execute of [true, false]) {
      const p = await setupPlayer(execute ? 'linkdrop1' : 'linkdrop2', { withBackpack: true });
      (ctx.linkDrop ??= []).push(p);
      await fb.fault({ disconnectAfter: { type: 'sync_apply', execute, holdDown: true, count: 1 } });
      const res = await startMove(p.uuid, A, B, p.name);
      eq(res.status, 201, 'POST move');
      const moveId = res.body.data.move.id;
      await waitFor('B received sync_apply and dropped the link', async () => {
        const s = await fb.state();
        return !s.connected && s.opsSeen.some((o) => o.type === 'sync_apply' && o.moveId === moveId);
      });
      await sleep(1000);
      const mid = await getMove(p.uuid, moveId);
      eq([mid.step, mid.outcome], ['apply', null], 'move while B is away');
      eq((await ledger(p.uuid)).state, 'applying', 'ledger while B is away');
      const c = await api('POST', playerPath(p.uuid, `/moves/${moveId}/cancel`));
      eq(c.status, 200, `cancel: ${JSON.stringify(c.body)}`);
      await sleep(1500);
      const still = await getMove(p.uuid, moveId);
      eq([still.step, still.outcome], ['apply', null], 'move after cancel, B still away');
      await fb.reconnect();
      const done = await waitOutcome(p.uuid, moveId, 60_000);
      const doc = await waitMoveDone(moveId);
      eq(doc.cancel?.reason, 'staff', 'cancel request on the move');
      assert(doc.ops.probe.length >= 1, 'no sync_probe after the cancel');
      const d = await ledger(p.uuid);
      const sa = await fa.state();
      const sb = await fb.state();
      if (done.outcome === 'committed') {
        await checkCommitted(p, moveId, 1);
      } else {
        eq([done.outcome, d.owner, d.version, d.state], ['cancelled', A, 1, 'online'], 'cancelled move');
        await waitFor('A clears its marks', async () => {
          const s = await fa.state();
          return !s.away[p.uuid] && !s.locks[`${BP}:${p.bp}`];
        });
        eq(stampOf(sa.dats[p.uuid])?.v, 1, 'stamp on A');
        assert(!stampOf(sb.dats[p.uuid]), 'B stamped a cancelled move');
      }
      outcomes.push(`${execute ? 'applied' : 'not applied'} on B → ${done.outcome}`);
    }
    eq(outcomes, ['applied on B → committed', 'not applied on B → cancelled'], 'outcomes');
    ctx.fNote = outcomes.join('; ');
  }],

  ['g', 'yggdrasil restart in the middle of a move', async () => {
    const p = await setupPlayer('restart', { withBackpack: true });
    ctx.restart = p;
    await fb.fault({ delayMs: { sync_apply: 6000 } });
    const res = await startMove(p.uuid, A, B, p.name);
    eq(res.status, 201, 'POST move');
    const moveId = res.body.data.move.id;
    await waitFor('B received sync_apply', async () => (await fb.state()).opsSeen.some((o) => o.type === 'sync_apply' && o.moveId === moveId));
    log('killing yggdrasil (SIGKILL) during apply');
    await stopYggdrasil('SIGKILL');
    startYggdrasil();
    await waitHealthy();
    await waitRegistered(fa);
    await waitRegistered(fb);
    const done = await waitOutcome(p.uuid, moveId, 120_000);
    eq([done.outcome, done.owner, done.version], ['committed', B, 1], 'move across a restart');
    await checkCommitted(p, moveId, 1);
    const apply = await mongo.db(DB_NAME).collection('biforesting_ops').findOne({ _id: (await moveDoc(moveId)).ops.apply });
    assert(apply.audit.some((a) => /boot-reset/.test(a.note ?? '')), 'the apply op was not in flight at the kill');
    eq(apply.state, 'completed', 'apply op state');
    await fb.fault({ reset: true });
  }],

  ['m', 'force-release while the player is online on A: kick and disown A first', async () => {
    const p = await setupPlayer('forcerel', { f: fb });
    ctx.forceRelease = p;
    const res = await startMove(p.uuid, B, A, p.name);
    eq(res.status, 201, `POST move B to A: ${JSON.stringify(res.body)}`);
    const moved = await waitOutcome(p.uuid, res.body.data.move.id, 30_000);
    eq([moved.outcome, moved.owner, moved.version], ['committed', A, 1], 'move B to A');
    await checkCommitted(p, moved.id, 1, fb, fa);
    const j = await fa.join(p.uuid, p.name);
    assert(j.ok, `login on A refused: ${JSON.stringify(j)}`);
    await waitFor('ledger sees the player online on A', async () => {
      const d = await ledger(p.uuid);
      return d?.lastSeen?.serverId === A && d.lastSeen.event === 'join';
    });

    const r1 = await api('POST', playerPath(p.uuid, '/force-release'), { to: B });
    eq([r1.status, r1.body.error?.code, r1.body.error?.details?.serverId], [409, 'player_online', A], `force-release while online: ${JSON.stringify(r1.body)}`);
    await waitFor('A kicks the player', async () => (await fa.state()).kicks.some((k) => k.uuid === p.uuid));
    const startedAt = Date.now();
    const r2 = await api('POST', playerPath(p.uuid, '/force-release'), { to: B });
    eq(r2.status, 201, `force-release after the kick: ${JSON.stringify(r2.body)}`);
    const fr = r2.body.data;
    eq([fr.kind, fr.vTo], ['force_release', 2], 'force-release move');
    const done = await waitOutcome(p.uuid, fr.id, 30_000);
    eq([done.outcome, done.owner, done.version], ['committed', B, 2], 'force-release outcome');
    const doc = await waitMoveDone(fr.id);
    eq(doc.disownTo, [A], 'force-release disownTo');
    const sa = await fa.state();
    const sb = await fb.state();
    const disownSeen = sa.opsSeen.find((o) => o.type === 'sync_disown' && o.at >= startedAt);
    const applySeen = sb.opsSeen.find((o) => o.type === 'sync_apply' && o.moveId === fr.id);
    assert(disownSeen && applySeen && disownSeen.at < applySeen.at, `the disown on A came after the apply on B: ${JSON.stringify([disownSeen, applySeen])}`);
    eq(sa.away[p.uuid] && [sa.away[p.uuid].v, sa.away[p.uuid].to], [2, B], 'away on A');
    eq(stampOf(sb.dats[p.uuid]), { g: GROUP, v: 2, m: fr.id }, 'stamp on B');
    assert(!sb.away[p.uuid], 'away on B after the force-release');
    const a2 = await fa.join(p.uuid, p.name);
    eq([a2.ok, a2.refused], [false, 'away'], 'login on A after the force-release');
    const b2 = await fb.join(p.uuid, p.name);
    assert(b2.ok, `login on B refused: ${JSON.stringify(b2)}`);
    await fb.quit(p.uuid);
  }],

  ['n', "apply crash between the .dat write and the state save: the re-apply clears B's away", async () => {
    const p = await setupPlayer('crash', { also: fb });
    ctx.crash = p;
    const j = await fb.join(p.uuid, p.name);
    assert(j.ok, `first login on B refused: ${JSON.stringify(j)}`);
    await waitFor('kick and away on B', async () => {
      const s = await fb.state();
      return s.kicks.some((k) => k.uuid === p.uuid) && s.away[p.uuid] ? s : null;
    });
    await fb.fault({ crashBeforeStateSave: { sync_apply: 1 } });
    const res = await startMove(p.uuid, A, B, p.name);
    eq(res.status, 201, `POST move: ${JSON.stringify(res.body)}`);
    const moveId = res.body.data.move.id;
    const crashed = await waitFor('B crashed in the apply', async () => {
      const s = await fb.state();
      return s.opsSeen.some((o) => o.type === 'sync_apply' && o.moveId === moveId) && stampOf(s.dats[p.uuid])?.m === moveId ? s : null;
    }, 30_000);
    assert(crashed.away[p.uuid], 'the crash left away on B');
    const done = await waitOutcome(p.uuid, moveId, 200_000);
    eq([done.outcome, done.owner, done.version], ['committed', B, 1], 'move across the crash');
    await checkCommitted(p, moveId, 1);
    const doc = await moveDoc(moveId);
    eq([doc.needsReapply, doc.attempts.reapply, doc.error], [false, 1, null], 're-apply on the move');
    eq((await fb.state()).opsSeen.filter((o) => o.type === 'sync_apply' && o.moveId === moveId).length, 2, 'sync_apply deliveries on B');
    const b2 = await fb.join(p.uuid, p.name);
    assert(b2.ok, `login on B after the re-apply refused: ${JSON.stringify(b2)}`);
    await fb.quit(p.uuid);
  }],

  ['o', 'player_sync off on A during an abort: the abort waits, then runs after the grant', async () => {
    const p = await setupPlayer('policyoff', { withBackpack: true });
    ctx.policyOff = p;
    await fb.fault({ delayMs: { sync_apply: 4000 }, answerCode: { sync_apply: { code: 'fingerprint_mismatch', count: 1 } } });
    const res = await startMove(p.uuid, A, B, p.name);
    eq(res.status, 201, `POST move: ${JSON.stringify(res.body)}`);
    const moveId = res.body.data.move.id;
    await waitFor('B received sync_apply', async () => (await fb.state()).opsSeen.some((o) => o.type === 'sync_apply' && o.moveId === moveId));
    const off = await api('PUT', `/v1/biforesting/${A}/policy`, { features: FEATURES.filter((f) => f !== 'player_sync') });
    eq(off.status, 200, `PUT policy A without player_sync: ${JSON.stringify(off.body)}`);
    await waitFor('A lost player_sync', async () => ((await fa.state()).granted & 0x80000) === 0);
    const aborted = await waitOutcome(p.uuid, moveId, 30_000);
    eq([aborted.outcome, aborted.code, aborted.owner, aborted.version], ['aborted', 'fingerprint_mismatch', A, 1], 'aborted move');
    await waitFor('the abort op parked', async () => (await moveDoc(moveId)).steps.some((s) => s.step === 'abort' && s.status === 'parked'));
    await sleep(3000);
    const still = await moveDoc(moveId);
    eq([still.step, still.attempts.abort, still.error?.code], ['abort', 1, 'fingerprint_mismatch'], 'the abort step while the bit is off');
    const sa = await fa.state();
    assert(!sa.opsSeen.some((o) => o.type === 'sync_abort' && o.moveId === moveId), 'A got sync_abort with the bit off');
    assert(sa.away[p.uuid], 'A has no away mark to clear');

    const on = await api('PUT', `/v1/biforesting/${A}/policy`, { features: FEATURES });
    eq(on.status, 200, 'PUT policy A with player_sync');
    await waitRegistered(fa);
    const doc = await waitMoveDone(moveId);
    eq([doc.error?.code, doc.attempts.abort, doc.uncounted.abort], ['fingerprint_mismatch', 2, 1], 'abort after the grant');
    await waitFor('A clears its marks', async () => {
      const s = await fa.state();
      return !s.away[p.uuid] && !s.locks[`${BP}:${p.bp}`];
    });
    const j = await fa.join(p.uuid, p.name);
    assert(j.ok, `login on A after the abort refused: ${JSON.stringify(j)}`);
    await fa.quit(p.uuid);
  }],

  ['p', 'release re-run builds another blob (another sha256): the move commits', async () => {
    const p = await setupPlayer('resalt', { withBackpack: true });
    ctx.resalt = p;
    await fa.fault({ failAfterRun: { sync_release: { code: 'handler_failed', count: 1 } }, saltRelease: true });
    const res = await startMove(p.uuid, A, B, p.name);
    eq(res.status, 201, `POST move: ${JSON.stringify(res.body)}`);
    const moveId = res.body.data.move.id;
    const done = await waitOutcome(p.uuid, moveId, 60_000);
    eq([done.outcome, done.owner, done.version], ['committed', B, 1], 'move after a re-run release');
    await checkCommitted(p, moveId, 1);
    const doc = await moveDoc(moveId);
    eq(doc.attempts.release, 2, 'release attempts');
    const list = await api('GET', playerPath(p.uuid, '/snapshots?kind=release'));
    const builds = list.body.data.snapshots.filter((s) => s.moveId === moveId);
    eq(builds.length, 2, 'release builds stored for the move');
    assert(builds[0].sha256 !== builds[1].sha256, 'the two builds have one sha256');
    const release = await mongo.db(DB_NAME).collection('biforesting_ops').findOne({ _id: doc.ops.release });
    eq(doc.snapshotId, builds.find((s) => s.sha256 === release.result.data.sha256)?._id, 'the move applied the second build');
  }],

  ['r', 'targetHasCharacter: true when B holds a .dat of the player, false when not', async () => {
    const withDat = await setupPlayer('targetdat', { also: fb });
    const noDat = await setupPlayer('targetnone');
    ctx.target = [withDat, noDat];
    const seen = [];
    for (const p of ctx.target) {
      assert(!!(await fb.state()).dats[p.uuid] === (p === withDat), `${p.name}: B .dat before the move`);
      const res = await startMove(p.uuid, A, B, p.name);
      eq(res.status, 201, `POST move: ${JSON.stringify(res.body)}`);
      const move = res.body.data.move;
      assert('targetHasCharacter' in move, `the 201 view has no targetHasCharacter: ${JSON.stringify(move)}`);
      const answered = await waitFor(`${p.name} targetHasCharacter`, async () => {
        const m = await getMove(p.uuid, move.id, `?waitMs=5000&step=${move.step}`);
        return m.targetHasCharacter !== null ? m : null;
      });
      seen.push(answered.targetHasCharacter);
      const done = await waitOutcome(p.uuid, move.id, 30_000);
      eq([done.outcome, done.owner, done.version, done.targetHasCharacter], ['committed', B, 1, p === withDat], `${p.name} committed move`);
      await checkCommitted(p, move.id, 1);
      const doc = await moveDoc(move.id);
      const probe = await mongo.db(DB_NAME).collection('biforesting_ops').findOne({ _id: doc.ops.targetProbe });
      eq([probe?.type, probe?.state, probe?.idempotencyKey], ['sync_probe', 'completed', `sync:${GROUP}:${p.uuid}:${move.id}:target-probe`], `${p.name} target probe op`);
      assert((await fb.state()).opsSeen.some((o) => o.opId === probe._id), `${p.name}: B never got the target probe`);
    }
    eq(seen, [true, false], 'targetHasCharacter of the two moves');
  }],

  ['q', 'reseed after a restore of A: the owner joins without a kick, a player who left A is refused there again', async () => {
    // P1 moves B to A, P2 moves A to B. P3 is in a move from B to A when A goes down for the restore.
    const p1 = await setupPlayer('reseedowner', { f: fb });
    const m1 = await startMove(p1.uuid, B, A, p1.name);
    eq(m1.status, 201, `POST move P1: ${JSON.stringify(m1.body)}`);
    const d1 = await waitOutcome(p1.uuid, m1.body.data.move.id, 30_000);
    eq([d1.outcome, d1.owner, d1.version], ['committed', A, 1], 'P1 on A');
    await checkCommitted(p1, d1.id, 1, fb, fa);
    const p2 = await setupPlayer('reseedleft');
    const m2 = await startMove(p2.uuid, A, B, p2.name);
    eq(m2.status, 201, `POST move P2: ${JSON.stringify(m2.body)}`);
    const d2 = await waitOutcome(p2.uuid, m2.body.data.move.id, 30_000);
    eq([d2.outcome, d2.owner, d2.version], ['committed', B, 1], 'P2 on B');
    await checkCommitted(p2, d2.id, 1);
    // The commit records A in the disowned list of P2 (spec 6.6), so the next register of A
    // queues no disown that would overwrite the move id of its away mark.
    await fa.reconnect();
    await waitRegistered(fa);
    await waitFor('P2 disowned lists A', async () => (await ledger(p2.uuid))?.disowned?.includes(A));
    eq((await fa.state()).away[p2.uuid]?.m, d2.id, 'away mark of P2 on A keeps the move id');
    const p3 = await setupPlayer('reseedmove', { f: fb });
    ctx.reseed = [p1, p2, p3];
    await fb.fault({ delayMs: { sync_prepare: 6000 } });
    const m3 = await startMove(p3.uuid, B, A, p3.name);
    eq(m3.status, 201, `POST move P3: ${JSON.stringify(m3.body)}`);
    const m3id = m3.body.data.move.id;

    const notFrozen = await api('POST', syncPath('/reseed'), { serverId: A });
    eq([notFrozen.status, notFrozen.body.error?.code], [409, 'not_frozen'], 'reseed of a group that is not frozen');
    eq((await api('PUT', syncPath(), { frozen: true, freezeReason: 'sync-e2e restore of A' })).status, 200, 'freeze');
    try {
      const outside = await api('POST', syncPath('/reseed'), { serverId: C });
      eq([outside.status, outside.body.error?.code], [409, 'not_member'], 'reseed of a server outside the group');

      // A goes down. Its world rolls back: P1 and P2 lose their stamps, P2 loses its away mark.
      await fa.disconnect({ holdDown: true });
      await waitFor('Yggdrasil sees A down', async () => (await api('GET', syncPath())).body.data?.instances?.find((i) => i.serverId === A)?.live === false);
      const restored = await fa.restore({ stamps: { [p1.uuid]: null, [p2.uuid]: null }, dropAway: [p2.uuid] });
      eq(restored.rolled?.length, 2, 'stamps rolled back on A');
      const sa0 = await fa.state();
      assert(!stampOf(sa0.dats[p1.uuid]) && !stampOf(sa0.dats[p2.uuid]) && !sa0.away[p2.uuid], 'A state after the restore');

      const rs = await api('POST', syncPath('/reseed'), { serverId: A });
      eq(rs.status, 200, `reseed: ${JSON.stringify(rs.body)}`);
      const r = rs.body.data;
      eq([r.serverId, r.movesAborted, r.movesStuck, r.disownBatches, r.ownBatches], [A, [m3id], [], 0, 0], 'reseed answer');
      assert(r.trusted >= 1 && r.disownsQueued >= 1, `reseed counts: ${JSON.stringify(r)}`);
      const l1 = await ledger(p1.uuid);
      eq([l1.owner, l1.version, l1.trustDisk], [A, 1, true], 'P1 ledger after the reseed');
      eq((await ledger(p2.uuid)).disowned.includes(A), false, 'P2 disowned lists A after the reseed');
      const moved = await waitOutcome(p3.uuid, m3id, 30_000);
      eq([moved.outcome, moved.code, moved.error?.code, moved.owner, moved.version], ['cancelled', 'cancelled', 'reseed', B, 0], 'P3 move after the reseed');

      // A comes back. Its register queues the disowns again: P2 is refused on A.
      await fa.reconnect();
      await waitRegistered(fa);
      await waitFor('A marks P2 away again', async () => (await fa.state()).away[p2.uuid]);
      await waitFor('P2 disowned lists A again', async () => (await ledger(p2.uuid))?.disowned?.includes(A));
      const j2 = await fa.join(p2.uuid, p2.name);
      eq([j2.ok, j2.refused], [false, 'away'], 'P2 login on A after the reseed');

      // P1 joins its owner A with the rolled-back .dat: no kick, the ledger takes the stamp.
      const j1 = await fa.join(p1.uuid, p1.name);
      assert(j1.ok, `P1 login on A refused: ${JSON.stringify(j1)}`);
      const taken = await waitFor('the ledger takes the stamp of A', async () => {
        const d = await ledger(p1.uuid);
        return d?.trustDisk === false && d.lastSeen?.serverId === A && d.lastSeen.event === 'join' ? d : null;
      });
      eq([taken.state, taken.owner, taken.version], ['online', A, 0], 'P1 ledger after its join on A');
      await sleep(1500);
      assert(!(await fa.state()).kicks.some((k) => k.uuid === p1.uuid), 'the detector kicked the owner on A');
      await fa.quit(p1.uuid);

      const again = await api('POST', syncPath('/reseed'), { serverId: A });
      eq([again.status, again.body.data?.movesAborted, again.body.data?.movesStuck, again.body.data?.trusted], [200, [], [], r.trusted], 'second reseed');
      const l1b = await ledger(p1.uuid);
      eq([l1b.owner, l1b.version], [A, 0], 'P1 ledger after the second reseed');
      await waitMoveDone(m3id);
      const sb = await fb.state();
      assert(!sb.moving[p3.uuid], 'B still marks P3 moving after the abort');
    } finally {
      await api('PUT', syncPath(), { frozen: false, freezeReason: null });
    }
  }],

  ['s', 'reseed after a restore of A that brings back an old away mark: sync_own clears it, the owner joins A without a refusal or a kick', async () => {
    // P moves A to B, then B to A. The backup of A is from between the two moves: it holds the
    // stamp and the away mark of the first move.
    const cooldownMs = (await api('GET', syncPath())).body.data?.cooldownMs ?? 600_000;
    eq((await api('PUT', syncPath(), { cooldownMs: 0 })).status, 200, 'cooldown off');
    try {
      const p = await setupPlayer('reseedown');
      ctx.reseedOwn = p;
      const m1 = await startMove(p.uuid, A, B, p.name);
      eq(m1.status, 201, `POST move 1: ${JSON.stringify(m1.body)}`);
      const d1 = await waitOutcome(p.uuid, m1.body.data.move.id, 30_000);
      eq([d1.outcome, d1.owner, d1.version], ['committed', B, 1], 'P on B');
      await checkCommitted(p, d1.id, 1);
      const sa1 = await fa.state();
      const backup = { stamp: stampOf(sa1.dats[p.uuid]), away: sa1.away[p.uuid] };
      eq([backup.stamp?.v, backup.away?.v, backup.away?.m], [1, 1, d1.id], 'A at the time of the backup');

      const m2 = await startMove(p.uuid, B, A, p.name);
      eq(m2.status, 201, `POST move 2: ${JSON.stringify(m2.body)}`);
      const d2 = await waitOutcome(p.uuid, m2.body.data.move.id, 30_000);
      eq([d2.outcome, d2.owner, d2.version], ['committed', A, 2], 'P back on A');
      await checkCommitted(p, d2.id, 2, fb, fa);

      eq((await api('PUT', syncPath(), { frozen: true, freezeReason: 'sync-e2e restore of A' })).status, 200, 'freeze');
      try {
        await fa.disconnect({ holdDown: true });
        await waitFor('Yggdrasil sees A down', async () => (await api('GET', syncPath())).body.data?.instances?.find((i) => i.serverId === A)?.live === false);
        await fa.restore({ stamps: { [p.uuid]: backup.stamp }, away: { [p.uuid]: backup.away } });
        const sa0 = await fa.state();
        eq([stampOf(sa0.dats[p.uuid])?.v, sa0.away[p.uuid]?.v], [1, 1], 'A after the restore');

        // A boots before the reseed. The restored away mark refuses its owner.
        await fa.reconnect();
        await waitRegistered(fa);
        const before = await fa.join(p.uuid, p.name);
        eq([before.ok, before.refused], [false, 'away'], 'P login on A before the reseed');

        const rs = await api('POST', syncPath('/reseed'), { serverId: A });
        eq(rs.status, 200, `reseed: ${JSON.stringify(rs.body)}`);
        const r = rs.body.data;
        eq([r.movesAborted, r.movesStuck], [[], []], 'reseed closed no move');
        assert(r.trusted >= 1 && r.ownBatches >= 1, `reseed counts: ${JSON.stringify(r)}`);
        const l0 = await ledger(p.uuid);
        eq([l0.owner, l0.version, l0.trustDisk], [A, 2, true], 'P ledger after the reseed');

        await waitFor('A clears the restored away mark of P', async () => !(await fa.state()).away[p.uuid]);
        const ops = mongo.db(DB_NAME).collection('biforesting_ops');
        const own = await waitFor('the sync_own to A completes', async () => {
          const o = await ops.findOne({ type: 'sync_own', 'params.entries.u': p.uuid });
          return o?.state === 'completed' ? o : null;
        });
        eq(own.params.entries.find((e) => e.u === p.uuid), { u: p.uuid, v: 2 }, 'sync_own entry of P');
        assert(own.idempotencyKey.startsWith(`sync:${GROUP}:own:${A}:`), `sync_own key ${own.idempotencyKey}`);
        assert(own.result?.data?.cleared >= 1, `sync_own result ${JSON.stringify(own.result)}`);
        const raw = await waitFor('ownPending cleared on P', async () => {
          const d = await mongo.db(DB_NAME).collection('biforesting_sync_players').findOne({ _id: `${GROUP}:${p.uuid}` });
          return d && !('ownPending' in d) ? d : null;
        });
        eq(raw.trustDisk, true, 'trustDisk waits for the join');

        const refusalsBefore = (await fa.state()).refusals.filter((x) => x.uuid === p.uuid).length;
        const j = await fa.join(p.uuid, p.name);
        assert(j.ok, `P login on A refused after the reseed: ${JSON.stringify(j)}`);
        const taken = await waitFor('the ledger takes the restored stamp of A', async () => {
          const d = await ledger(p.uuid);
          return d?.trustDisk === false && d.lastSeen?.serverId === A && d.lastSeen.event === 'join' ? d : null;
        });
        eq([taken.state, taken.owner, taken.version], ['online', A, 1], 'P ledger after its join on A');
        await sleep(1500);
        const sa = await fa.state();
        assert(!sa.kicks.some((k) => k.uuid === p.uuid), 'the detector kicked the owner on A');
        eq(sa.refusals.filter((x) => x.uuid === p.uuid).length, refusalsBefore, 'refusals of P on A after the reseed');
        await fa.quit(p.uuid);
      } finally {
        await api('PUT', syncPath(), { frozen: false, freezeReason: null });
      }
    } finally {
      await api('PUT', syncPath(), { cooldownMs });
    }
  }],

  ['t', 'reseed after a restore of A that brings back a backpack that moved to B: sync_lock locks the record foreign on A', async () => {
    const p = await setupPlayer('reseedbp', { withBackpack: true });
    const lk = `${BP}:${p.bp}`;
    const record = (await fa.state()).worldData[BP][p.bp];
    assert(!!record, 'A holds the backpack record before the move');
    const m = await startMove(p.uuid, A, B, p.name);
    eq(m.status, 201, `POST move: ${JSON.stringify(m.body)}`);
    const d = await waitOutcome(p.uuid, m.body.data.move.id, 30_000);
    eq([d.outcome, d.owner, d.version], ['committed', B, 1], 'P on B');
    await checkCommitted(p, d.id, 1);
    const wdColl = mongo.db(DB_NAME).collection('biforesting_sync_worlddata');
    const ops = mongo.db(DB_NAME).collection('biforesting_ops');

    eq((await api('PUT', syncPath(), { frozen: true, freezeReason: 'sync-e2e restore of A' })).status, 200, 'freeze');
    try {
      await fa.disconnect({ holdDown: true });
      await waitFor('Yggdrasil sees A down', async () => (await api('GET', syncPath())).body.data?.instances?.find((i) => i.serverId === A)?.live === false);
      // The backup of A is from before the move: the record is there, with no tombstone, and P
      // has no stamp and no away mark.
      await fa.restore({ stamps: { [p.uuid]: null }, dropAway: [p.uuid], worldData: { [BP]: { [p.bp]: record } }, locks: { [lk]: null } });
      const sa0 = await fa.state();
      eq([!!sa0.worldData[BP][p.bp], sa0.locks[lk] ?? null, !!sa0.away[p.uuid]], [true, null, false], 'A after the restore');
      eq((await fa.open(BP, p.bp)).refused, null, 'the stale backpack opens on A before the reseed: the dupe');

      const rs = await api('POST', syncPath('/reseed'), { serverId: A });
      eq(rs.status, 200, `reseed: ${JSON.stringify(rs.body)}`);
      eq(rs.body.data.lockBatches, 0, 'A is down: the lock batch waits for its register');
      const wd0 = await wdColl.findOne({ _id: `${GROUP}:${lk}` });
      eq([wd0?.state, wd0?.owner, wd0?.lockPending], ['owned', B, [A]], 'worlddata after the reseed');

      await fa.reconnect();
      await waitRegistered(fa);
      const lock = await waitFor('A locks the record foreign', async () => {
        const l = (await fa.state()).locks[lk];
        return l?.state === 'foreign' ? l : null;
      });
      eq([lock.to, lock.toLabel], [B, 'Instance 2'], 'foreign lock on A');
      const op = await waitFor('the sync_lock to A completes', async () => {
        const o = await ops.findOne({ type: 'sync_lock', 'params.entries.key': p.bp });
        return o?.state === 'completed' ? o : null;
      });
      assert(op.idempotencyKey.startsWith(`sync:${GROUP}:lock:${A}:`), `sync_lock key ${op.idempotencyKey}`);
      eq(op.target, null, 'sync_lock has no target');
      eq(op.params.entries.find((e) => e.key === p.bp), { h: BP, key: p.bp, to: B, toLabel: 'Instance 2' }, 'sync_lock entry');
      assert(op.result?.data?.locked >= 1 && op.result?.data?.kept === 0, `sync_lock result ${JSON.stringify(op.result)}`);
      await waitFor('lockPending cleared', async () => {
        const w = await wdColl.findOne({ _id: `${GROUP}:${lk}` });
        return w && (w.lockPending ?? []).length === 0 ? w : null;
      });
      eq((await fa.open(BP, p.bp)).refused, 'This storage is on Instance 2.', 'the stale backpack on A refuses to open');
      eq((await fb.open(BP, p.bp)).refused, null, 'B opens its record');
      await waitFor('A marks P away again', async () => (await fa.state()).away[p.uuid]);

      // A second reseed with A up queues the lock again, and the mod answers it with no change.
      const again = await api('POST', syncPath('/reseed'), { serverId: A });
      eq([again.status, again.body.data?.lockBatches], [200, 1], 'second reseed');
      await waitFor('the second sync_lock completes', async () => {
        const w = await wdColl.findOne({ _id: `${GROUP}:${lk}` });
        return w && (w.lockPending ?? []).length === 0 ? w : null;
      });
      eq((await fa.state()).locks[lk]?.state, 'foreign', 'still foreign on A');
    } finally {
      await api('PUT', syncPath(), { frozen: false, freezeReason: null });
    }
  }],

  ['u', 'quests: status and each /quests action on the owner, with pre_action snapshots', async () => {
    await ensureQuestGroup();
    const p = await questPlayer('actions');
    const host = '00000000-0000-4000-9000-0000000fffff';
    await fq1.quests({ teams: { [p.uuid]: { kind: 'player', name: p.name, owner: p.uuid, members: [p.uuid], done: ['q1', 'q2', 'q3'] } } });
    let r = await api('GET', qPath(p.uuid));
    eq(r.status, 200, `status: ${JSON.stringify(r.body)}`);
    const s = r.body.data;
    eq([s.owner, s.book.kind, s.book.teamId, s.book.owner, s.done, s.pref], [Q1, 'player', p.uuid, null, 3, 'merge'], 'status');

    r = await api('POST', qPath(p.uuid, '/action'), { action: 'pref', value: 'separate' });
    eq([r.status, r.body.data?.ok], [200, true], `pref: ${JSON.stringify(r.body)}`);
    eq((await fq1.state()).quests.pref[p.uuid], 'separate', 'pref on Q1');
    r = await api('POST', qPath(p.uuid, '/action'), { action: 'pref' });
    eq([r.status, r.body.error?.code], [400, 'bad_value'], 'pref without a value');

    r = await api('POST', qPath(p.uuid, '/action'), { action: 'fresh' });
    eq([r.status, r.body.data?.ok], [200, true], `fresh: ${JSON.stringify(r.body)}`);
    const freshId = r.body.data.backupId;
    eq((await fq1.state()).quests.teams[p.uuid].done, [], 'fresh cleared the book');

    r = await api('POST', qPath(p.uuid, '/action'), { action: 'undo', backupId: freshId });
    eq([r.status, r.body.data?.ok, r.body.data?.backupId], [200, true, freshId], `undo: ${JSON.stringify(r.body)}`);
    eq((await fq1.state()).quests.teams[p.uuid].done, ['q1', 'q2', 'q3'], 'undo restored the book');
    r = await api('POST', qPath(p.uuid, '/action'), { action: 'undo', backupId: freshId });
    eq([r.status, r.body.data?.ok, r.body.data?.code], [200, false, 'already_undone'], 'a second undo of one backup');

    const party = newTeamId();
    await fq1.quests({ teams: { [party]: { kind: 'party', name: 'Club', owner: host, members: [host, p.uuid], done: ['q4', 'q5'] } } });
    r = await api('GET', qPath(p.uuid));
    eq([r.body.data?.book?.kind, r.body.data?.book?.teamId, r.body.data?.book?.owner], ['party', party, host], 'status in a party');
    r = await api('POST', qPath(p.uuid, '/action'), { action: 'fresh' });
    eq([r.status, r.body.data?.ok, r.body.data?.code], [200, false, 'in_party'], 'fresh in a party');
    r = await api('POST', qPath(p.uuid, '/action'), { action: 'leave' });
    eq([r.status, r.body.data?.ok], [200, true], `leave: ${JSON.stringify(r.body)}`);
    const st = await fq1.state();
    assert(!st.quests.teams[party].members.includes(p.uuid), 'still a party member after leave');
    eq(st.quests.teams[p.uuid].done, ['q1', 'q2', 'q3', 'q4', 'q5'], 'leave merged the party book into the player team');

    const snaps = await preActionSnaps(p.uuid, 3);
    eq(snaps.map((x) => x.header.action).sort(), ['fresh', 'leave', 'undo'], 'one pre_action snapshot per write');
    assert(snaps.some((x) => x.header.action === 'fresh' && x.header.backupId === freshId), 'the fresh snapshot names its backup');
    eq(await questLease(p.uuid), null, 'no quest lock is left');
  }],
  ['v', 'quests: party candidates fan out to the other members; one member down gives a partial answer', async () => {
    await ensureQuestGroup();
    const p = await questPlayer('cand');
    const t2 = newTeamId();
    const t3 = newTeamId();
    await fq2.quests({ teams: { [t2]: { kind: 'party', name: 'Two', owner: p.uuid, members: [p.uuid], done: ['a', 'b'] } } });
    await fq3.quests({ teams: { [t3]: { kind: 'party', name: 'Three', owner: p.uuid, members: [p.uuid], done: ['c'] } } });
    let r = await api('GET', qPath(p.uuid, '/party-candidates'));
    eq(r.status, 200, `candidates: ${JSON.stringify(r.body)}`);
    eq(r.body.data.parties.map((x) => [x.serverId, x.teamId, x.done]).sort(), [[Q2, t2, 2], [Q3, t3, 1]], 'both parties');
    eq([r.body.data.partial, r.body.data.offline], [false, []], 'every member answered');

    await fq3.disconnect({ holdDown: true });
    try {
      await waitFor('Q3 link down', async () => {
        const g = await api('GET', `/v1/biforesting/sync/${QGROUP}`);
        return g.body.data?.instances?.find((i) => i.serverId === Q3)?.live === false;
      });
      const started = Date.now();
      r = await api('GET', qPath(p.uuid, '/party-candidates'));
      eq(r.status, 200, `candidates with Q3 down: ${JSON.stringify(r.body)}`);
      eq(r.body.data.parties.map((x) => [x.serverId, x.teamId]), [[Q2, t2]], 'Q2 still answers');
      eq([r.body.data.partial, r.body.data.offline], [true, [Q3]], 'Q3 is listed offline');
      assert(Date.now() - started < 5_000, 'a member that is down does not hold the answer');
    } finally {
      await fq3.reconnect();
      await waitRegistered(fq3);
    }
  }],
  ['w', 'quests: a party merge from another instance runs once; the same pair is refused twice', async () => {
    await ensureQuestGroup();
    const p = await questPlayer('merge');
    const friend = '00000000-0000-4000-9000-0000000ffffe';
    const target = newTeamId();
    const source = newTeamId();
    await fq1.quests({ teams: { [target]: { kind: 'party', name: 'Home', owner: p.uuid, members: [p.uuid, friend], done: ['a', 'b'] } } });
    await fq2.quests({ teams: { [source]: { kind: 'party', name: 'Away', owner: friend, members: [friend, p.uuid], done: ['b', 'c', 'd'] } } });
    let r = await api('POST', qPath(p.uuid, '/party-merge'), { fromServer: Q2, teamId: source });
    eq([r.status, r.body.data?.ok, r.body.data?.merge?.state], [200, true, 'done'], `merge: ${JSON.stringify(r.body)}`);
    const backupId = r.body.data.backupId;
    eq((await fq1.state()).quests.teams[target].done, ['a', 'b', 'c', 'd'], 'the source book merged into the party');
    const doc = await mongo.db(DB_NAME).collection('biforesting_sync_quest_merges').findOne({ _id: `${QGROUP}:${Q2}:${source}:${Q1}:${target}` });
    eq([doc?.state, doc?.backupId], ['done', backupId], 'the merge doc');

    for (let i = 1; i <= 2; i++) {
      r = await api('POST', qPath(p.uuid, '/party-merge'), { fromServer: Q2, teamId: source });
      eq([r.status, r.body.error?.code], [409, 'already_merged'], `merge again (${i})`);
    }
    eq((await fq1.state()).quests.imports.filter((x) => x.uuid === p.uuid).length, 1, 'one import on Q1');
    r = await api('GET', qPath(p.uuid, '/party-candidates'));
    const cand = r.body.data?.parties?.find((x) => x.teamId === source);
    eq(cand?.mergedInto?.map((m) => [m.targetServerId, m.targetTeamId]), [[Q1, target]], 'the candidate lists the merge');
    const snaps = await preActionSnaps(p.uuid, 1);
    assert(snaps.some((x) => x.header.action === 'party_merge' && x.header.backupId === backupId), 'pre_action snapshot of the merge');
    eq(await questLease(p.uuid), null, 'no quest lock is left');
  }],
  ['x', 'quests: an action during a move gets 409 moving; a move during an action gets 409 moving', async () => {
    await ensureQuestGroup();
    const p = await questPlayer('move');
    try {
      await fq1.fault({ delayMs: { sync_prepare: 2_500 } });
      let r = await api('POST', playerPath(p.uuid, '/moves', QGROUP), { from: Q1, to: Q2, name: p.name, reason: 'sync-e2e' });
      eq(r.status, 201, `move: ${JSON.stringify(r.body)}`);
      const moveId = r.body.data.move.id;
      r = await api('POST', qPath(p.uuid, '/action'), { action: 'fresh' });
      eq([r.status, r.body.error?.code], [409, 'moving'], 'an action during the move');
      r = await api('GET', qPath(p.uuid));
      eq([r.status, r.body.error?.code], [409, 'moving'], 'status during the move');
      r = await api('POST', qPath(p.uuid, '/party-merge'), { fromServer: Q3, teamId: newTeamId() });
      eq([r.status, r.body.error?.code], [409, 'moving'], 'a party merge during the move');
      eq(
        (await fq1.state()).opsSeen.filter((o) => o.uuid === p.uuid && o.type.startsWith('quests_')).length,
        0,
        'no quest op reached Q1 during the move',
      );
      const done = await waitOutcome(p.uuid, moveId, 60_000, QGROUP);
      eq([done.outcome, done.owner], ['committed', Q2], 'the move commits');
      await waitMoveDone(moveId);

      r = await api('GET', qPath(p.uuid));
      eq([r.status, r.body.data?.owner], [200, Q2], 'status now goes to Q2');
      await fq2.fault({ delayMs: { quests_action: 2_500 } });
      const pending = api('POST', qPath(p.uuid, '/action'), { action: 'pref', value: 'merge' });
      await waitFor('quest lock on the ledger', async () => (await questLease(p.uuid))?.holder?.startsWith('quests:'));
      r = await api('POST', playerPath(p.uuid, '/moves', QGROUP), { from: Q2, to: Q1, name: p.name, reason: 'sync-e2e' });
      eq([r.status, r.body.error?.code], [409, 'moving'], `a move during the action: ${JSON.stringify(r.body)}`);
      const a = await pending;
      eq([a.status, a.body.data?.ok], [200, true], `the action: ${JSON.stringify(a.body)}`);
      eq(await questLease(p.uuid), null, 'the lock is gone after the answer');
    } finally {
      await fq1.fault({ reset: true });
      await fq2.fault({ reset: true });
    }
  }],
  ['y', 'quests: a mod without the quest ops answers unsupported_op; the calls end at once with not_ready', async () => {
    await ensureQuestGroup();
    const p = await questPlayer('oldjar');
    try {
      await fq1.fault({ answerCode: { quests_status: { code: 'unsupported_op' }, quests_action: { code: 'unsupported_op' } } });
      const started = Date.now();
      let r = await api('GET', qPath(p.uuid));
      eq([r.status, r.body.error?.code], [409, 'not_ready'], `status: ${JSON.stringify(r.body)}`);
      r = await api('POST', qPath(p.uuid, '/action'), { action: 'fresh' });
      eq([r.status, r.body.error?.code], [409, 'not_ready'], `action: ${JSON.stringify(r.body)}`);
      assert(Date.now() - started < 5_000, 'both answer at once');
      eq(await questLease(p.uuid), null, 'no quest lock is left');
    } finally {
      await fq1.fault({ reset: true });
    }
  }],
  ['l', 'dupe audit', async () => {
    const sa = await fa.state();
    const sb = await fb.state();
    const problems = [];
    for (const [uuid, name] of players) {
      const d = await ledger(uuid);
      if (!d) {
        problems.push(`${name}: no ledger doc`);
        continue;
      }
      if (d.state !== 'online' || d.move !== null) problems.push(`${name}: ledger ${d.state} move ${JSON.stringify(d.move)}`);
      const owns = (s) => {
        const dt = s.dats[uuid];
        return !!dt && !s.away[uuid] && (stampOf(dt)?.v ?? 0) === d.version;
      };
      const owners = [sa, sb].filter(owns).map((s) => s.serverId);
      if (owners.length !== 1 || owners[0] !== d.owner) problems.push(`${name}: ledger owner ${d.owner} v${d.version}, instances that own it: ${owners.join(',') || 'none'}`);
      for (const s of [sa, sb]) {
        if (s.serverId === d.owner) continue;
        const v = stampOf(s.dats[uuid])?.v ?? 0;
        if (s.dats[uuid] && !s.away[uuid] && v >= d.version) problems.push(`${name}: ${s.serverId} holds a usable copy at v${v}`);
      }
    }
    const wdDocs = await mongo.db(DB_NAME).collection('biforesting_sync_worlddata').find({}).toArray();
    const keys = new Set([...Object.keys(sa.worldData[BP]), ...Object.keys(sb.worldData[BP]), ...wdDocs.map((w) => w.key)]);
    for (const key of keys) {
      const live = [sa, sb].filter((s) => s.worldData[BP][key] && !['out', 'tombstone', 'foreign'].includes(s.locks[`${BP}:${key}`]?.state)).map((s) => s.serverId);
      if (live.length !== 1) problems.push(`backpack ${key}: live on ${live.join(',') || 'nobody'}`);
      const w = wdDocs.find((x) => x.key === key);
      if (w && (w.state !== 'owned' || w.owner !== live[0])) problems.push(`backpack ${key}: worlddata ${w.state}(${w.owner}), live on ${live.join(',')}`);
    }
    const open = await mongo.db(DB_NAME).collection('biforesting_sync_moves').find({ step: { $ne: 'done' } }).toArray();
    for (const m of open) problems.push(`move ${m._id} still open at step ${m.step}`);
    const g = await api('GET', syncPath());
    const counts = g.body.data?.counts ?? {};
    if (counts.moving || counts.applying || counts.stuck) problems.push(`group counts ${JSON.stringify(counts)}`);
    log(`audit: ${players.size} players, ${keys.size} backpack keys, ${wdDocs.length} worlddata docs`);
    assert(problems.length === 0, problems.join('; '));
  }],
];

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const only = process.argv.slice(2);
  mem = await MongoMemoryServer.create({ instance: { port: MONGO_PORT, ip: '127.0.0.1' } });
  mongo = new MongoClient(`mongodb://127.0.0.1:${MONGO_PORT}`);
  await mongo.connect();
  await mongo.db('bifrost').collection('servers').insertMany([
    { tag: 'evol', serverId: A, name: 'Evolution 1', group: GROUP, instanceNumber: 1 },
    { tag: 'evol', serverId: B, name: 'Evolution 2', group: GROUP, instanceNumber: 2 },
    { tag: 'solo', serverId: C, name: 'Solo', instanceNumber: 1 },
    { tag: QGROUP, serverId: Q1, name: 'Quests 1', group: QGROUP, instanceNumber: 1 },
    { tag: QGROUP, serverId: Q2, name: 'Quests 2', group: QGROUP, instanceNumber: 2 },
    { tag: QGROUP, serverId: Q3, name: 'Quests 3', group: QGROUP, instanceNumber: 3 },
  ]);
  log(`mongod on ${MONGO_PORT}, servers seeded`);

  startYggdrasil();
  await waitHealthy();
  log('yggdrasil healthy');
  startFake(A);
  startFake(B);
  await waitRegistered(fa, false);
  await waitRegistered(fb, false);
  for (const s of [A, B]) {
    const r = await api('PUT', `/v1/biforesting/${s}/policy`, { features: FEATURES });
    assert(r.status === 200 && r.body.data?.reAcked === true, `policy ${s}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  }
  await waitRegistered(fa);
  await waitRegistered(fb);
  log('fakes registered with player_sync');

  const results = [];
  for (const [id, title, fn] of scenarios) {
    if (only.length > 0 && !only.includes(id)) continue;
    log(`── scenario ${id}: ${title}`);
    const started = Date.now();
    try {
      await resetFaults();
      await fn();
      results.push([id, true]);
      console.log(`PASS ${id} ${title} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    } catch (e) {
      results.push([id, false]);
      console.log(`FAIL ${id} ${title}: ${e instanceof Check ? e.message : e.stack}`);
    }
  }
  if (ctx.fNote) log(`scenario f outcomes: ${ctx.fNote}`);
  const failed = results.filter(([, ok]) => !ok).map(([id]) => id);
  console.log(failed.length === 0 ? `ALL PASS (${results.length} scenarios)` : `FAILED: ${failed.join(' ')}`);
  return failed.length === 0 ? 0 : 1;
}

let exitCode = 1;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`${sig}: stopping`);
    void cleanup().finally(() => process.exit(130));
  });
}
try {
  exitCode = await main();
} catch (e) {
  console.log(`FAIL setup: ${e instanceof Check ? e.message : e.stack}`);
} finally {
  await cleanup();
  log('stopped yggdrasil, fake mods and mongod');
}
process.exit(exitCode);
