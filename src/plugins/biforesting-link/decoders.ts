import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Reader, Writer } from './frame-codec.js';
import type { LinkMetrics, LedgerMetrics, LedgerBudget, RegistryPayload, QuestTeam, ChunkTeam, RegisterInfo, RegAck, OpResMsg, PresenceMsg, InvSnapHeader, QuestRegPayload, QuestRegRow, ItemRegPayload, ItemRegRow, ItemVariant } from './types.js';
import type { DecodedSyncSnap, RegisterSync, SyncBlockedEntry, SyncLinkEntry, SyncSnapHeader, SyncSnapKind, SyncWorldDataEntry } from './types.js';

/**
 * Payload decoders/encoders for the four link channels. Field order mirrors
 * `bifrost-lib/test/ygg_mock.py` and `Bifrost/docs/biforesting-protocol.md` §5.
 * All payloads start with `[protocolVersion : varint] = 1`.
 */

// ── UP decoders ──────────────────────────────────────────────────────────────

export function decodeMetrics(payload: Buffer): LinkMetrics {
  const r = new Reader(payload);
  const version = r.varInt();
  if (version >= 2) {
    // v2: [varint 2][utf json] — global window + per-dim timing + census (plan D9/D13)
    const o = JSON.parse(r.utf()) as {
      msptAvg: number;
      msptMax: number;
      tps: number;
      players: number;
      heapUsed: number;
      heapMax: number;
      perDim: LinkMetrics['perDim'];
      censusAgeMs: number;
      ledger?: unknown;
    };
    const perDim = Array.isArray(o.perDim) ? o.perDim : [];
    let loadedChunks = 0;
    for (const d of perDim) loadedChunks += d.loadedChunks || 0;
    const ledger = decodeLedger(o.ledger);
    return {
      mspt: o.msptAvg,
      tps: o.tps,
      players: o.players,
      levels: perDim.length,
      loadedChunks,
      heapUsed: o.heapUsed,
      heapMax: o.heapMax,
      v: version,
      msptMax: o.msptMax,
      perDim,
      censusAgeMs: o.censusAgeMs,
      ...(ledger ? { ledger } : {}),
    };
  }
  const mspt = r.float();
  const tps = r.float();
  const players = r.varInt();
  const levels = r.varInt();
  const loadedChunks = r.varInt();
  const heapUsed = Number(r.long());
  const heapMax = Number(r.long());
  return { mspt, tps, players, levels, loadedChunks, heapUsed, heapMax };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** JSON can say 1e999, which parses to Infinity, so a plain typeof check is not enough. */
function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** The finite number fields `keys` of `src`. Absent or bad fields stay out (no undefined keys for Mongo). */
function pickNumbers<K extends string>(src: Record<string, unknown>, keys: readonly K[]): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const k of keys) {
    const n = finite(src[k]);
    if (n !== undefined) out[k] = n;
  }
  return out;
}

/** Rows with a string name and a finite ms. Other rows are dropped. */
function ledgerRows(v: unknown): Array<Record<string, unknown> & { name: string; ms: number }> {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (r): r is Record<string, unknown> & { name: string; ms: number } =>
      isRecord(r) && typeof r['name'] === 'string' && finite(r['ms']) !== undefined,
  );
}

/** A source key Mongo or JS treat in a special way ('$x', dotted paths, `__proto__`) is dropped. */
function plainKey(k: string): boolean {
  return k.length > 0 && !k.startsWith('$') && !k.includes('.') && k !== '__proto__';
}

/**
 * The metrics `ledger` block (v1). Keeps only well-typed fields and rows, never throws.
 * Returns undefined when the block is absent or not an object.
 */
export function decodeLedger(raw: unknown): LedgerMetrics | undefined {
  if (!isRecord(raw)) return undefined;
  const sources: Record<string, number> = {};
  if (isRecord(raw['sources'])) {
    for (const [k, v] of Object.entries(raw['sources'])) {
      const n = finite(v);
      if (n !== undefined && plainKey(k)) sources[k] = n;
    }
  }
  const out: LedgerMetrics = {
    ...pickNumbers(raw, ['v', 'windowTicks', 'tickMs', 'coverage'] as const),
    sources,
    enclosing: ledgerRows(raw['enclosing']).map((r) => ({ name: r.name, ms: r.ms, ...pickNumbers(r, ['coverage'] as const) })),
    owners: ledgerRows(raw['owners']).map((r) => ({ name: r.name, ms: r.ms, ...pickNumbers(r, ['maxDivisor'] as const) })),
  };
  const b = raw['budget'];
  if (isRecord(b)) {
    const budget: LedgerBudget = pickNumbers(b, [
      'msptEma', 'machineMs', 'budgetMs', 'capMs', 'throttledUnits', 'throttledOwners', 'savingMs',
    ] as const);
    if (typeof b['mode'] === 'string' && b['mode']) budget.mode = b['mode'];
    out.budget = budget;
  }
  return out;
}

export function decodeRegistry(payload: Buffer): RegistryPayload {
  const r = new Reader(payload);
  r.varInt(); // version
  const count = r.varInt();
  const entries = new Array<{ id: string; numericId: number }>(count);
  for (let i = 0; i < count; i++) {
    const id = r.utf();
    const numericId = r.varInt();
    entries[i] = { id, numericId };
  }
  return { count, entries };
}

/**
 * `biforesting:registry` — version-aware (phase 8). v2 = `[varint 2][varint gzLen][gz utf8-json]`
 * (`{source, count, complete, stats?, items:[{id, num?, mod, display, maxStack, variants?}]}`);
 * v1 = `[varint 1][varint count][{utf id}{varint num}]…` (id→numericId only), decoded into the
 * same shape (empty display/variants, `complete:true`, `source:'legacy'`) so the store is
 * version-agnostic. Packs ship thousands of items → v2 always travels gzipped.
 */
export function decodeItemRegistry(payload: Buffer): ItemRegPayload {
  const r = new Reader(payload);
  const version = r.varInt();
  if (version === 1) {
    const count = r.varInt();
    const items: ItemRegRow[] = new Array<ItemRegRow>(count);
    for (let i = 0; i < count; i++) {
      const id = r.utf();
      const num = r.varInt();
      items[i] = { id, num, mod: namespaceOf(id), display: '', maxStack: 0, variants: [] };
    }
    return { version: 1, source: 'legacy', complete: true, count, items };
  }
  if (version !== 2) throw new Error(`unsupported registry version ${version}`);
  const gzLen = r.varInt();
  const gz = r.bytes(gzLen);
  // maxOutputLength: the 16MB frame cap bounds only the COMPRESSED size — JSON gzips ~1000x, so
  // an unbounded inflate is a zip-bomb vector. 64MB ≈ 150× the largest observed dump (41829
  // items = ~405KB gz / ~4MB raw); over-limit throws and the dispatch catch rejects the message.
  const raw = JSON.parse(gunzipSync(gz, { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8')) as Record<string, unknown>;
  const rows = Array.isArray(raw['items']) ? (raw['items'] as Array<Record<string, unknown>>) : [];
  const items: ItemRegRow[] = rows
    .filter((it) => typeof it['id'] === 'string' && it['id'].length > 0)
    .map((it) => {
      const id = it['id'] as string;
      const variantsRaw = Array.isArray(it['variants']) ? (it['variants'] as Array<Record<string, unknown>>) : [];
      const variants: ItemVariant[] = variantsRaw.map((v) => ({
        meta: typeof v['meta'] === 'number' ? v['meta'] : 0,
        display: typeof v['display'] === 'string' ? v['display'] : '',
      }));
      return {
        id,
        num: typeof it['num'] === 'number' ? it['num'] : 0,
        mod: typeof it['mod'] === 'string' && it['mod'] ? it['mod'] : namespaceOf(id),
        display: typeof it['display'] === 'string' ? it['display'] : '',
        maxStack: typeof it['maxStack'] === 'number' ? it['maxStack'] : 0,
        variants,
      };
    });
  return {
    version: 2,
    source: typeof raw['source'] === 'string' ? raw['source'] : 'unknown',
    complete: raw['complete'] !== false,
    count: typeof raw['count'] === 'number' ? raw['count'] : items.length,
    items,
    stats: typeof raw['stats'] === 'object' && raw['stats'] !== null ? (raw['stats'] as Record<string, number>) : undefined,
  };
}

function namespaceOf(id: string): string {
  const colon = id.indexOf(':');
  return colon > 0 ? id.slice(0, colon) : 'minecraft';
}

export function decodeQuest(payload: Buffer): QuestTeam[] {
  const r = new Reader(payload);
  r.varInt(); // version
  const n = r.varInt();
  const teams = new Array<QuestTeam>(n);
  for (let i = 0; i < n; i++) {
    const teamId = r.utf();
    const dataVersion = r.varInt();
    const snbt = r.utf();
    teams[i] = { teamId, dataVersion, snbt };
  }
  return teams;
}

export function decodeChunks(payload: Buffer): ChunkTeam[] {
  const r = new Reader(payload);
  r.varInt(); // version
  const n = r.varInt();
  const teams = new Array<ChunkTeam>(n);
  for (let i = 0; i < n; i++) {
    const teamId = r.utf();
    const claimCount = r.varInt();
    const claims = new Array<{ dimension: string; x: number; z: number; force: boolean }>(claimCount);
    for (let j = 0; j < claimCount; j++) {
      const dimension = r.utf();
      const x = r.varInt();
      const z = r.varInt();
      const force = r.bool();
      claims[j] = { dimension, x, z, force };
    }
    teams[i] = { teamId, claims };
  }
  return teams;
}

/**
 * Decode `biforesting:register`:
 *   [varint ver=1][utf serverId][utf friendlyHint][varint capabilities]
 *   [utf node][utf gameAddr][int64 bootNonce]
 *
 * `bootNonce` is read as a BigInt (it may exceed JS safe-int range) and kept as a
 * string — never coerced to Number.
 *
 * v2 can carry an optional `[utf syncJson]` tail (player-sync spec 3.2). An unusable tail never
 * fails the register: `sync` stays absent and `onBadSyncTail` gets the reason.
 */
export function decodeRegister(payload: Buffer, onBadSyncTail?: (reason: string) => void): RegisterInfo {
  const r = new Reader(payload);
  const ver = r.varInt(); // message-format version: 1 (feat-era) or 2 (+linkProtocolVersion)
  const serverId = r.utf();
  const friendlyHint = r.utf();
  const capabilities = r.varInt();
  const node = r.utf();
  const gameAddr = r.utf();
  const bootNonce = r.long().toString();
  const linkProtocolVersion = ver >= 2 ? r.varInt() : 1;
  const info: RegisterInfo = { serverId, friendlyHint, capabilities, node, gameAddr, bootNonce, linkProtocolVersion };
  if (ver >= 2 && r.remaining() > 0) {
    const sync = readRegisterSync(r);
    if (typeof sync === 'string') onBadSyncTail?.(sync);
    else info.sync = sync;
  }
  return info;
}

/** The register sync tail, or the reason it is unusable. Bytes after the tail are ignored. */
function readRegisterSync(r: Reader): RegisterSync | string {
  let raw: unknown;
  try {
    const len = r.varInt();
    raw = JSON.parse(r.bytes(len).toString('utf8'));
  } catch (err) {
    return `unreadable sync tail: ${(err as Error).message}`;
  }
  if (!isRecord(raw)) return 'sync tail is not a JSON object';
  const fp = raw['fp'];
  const cfg = raw['cfg'];
  const dv = finite(raw['dv']);
  const mods = finite(raw['mods']);
  const items = finite(raw['items']);
  if (typeof fp !== 'string' || fp.length === 0 || typeof cfg !== 'string') return 'sync tail needs string fp and cfg';
  if (dv === undefined || mods === undefined || items === undefined) return 'sync tail needs numeric dv, mods and items';
  return { fp, dv, mods, items, cfg };
}

// ── DOWN encoders (authoritative pushes) ─────────────────────────────────────

/**
 * Encode `biforesting:reg_ack` (v2):
 *   [varint ver=2][byte accepted(1/0)][utf canonicalServerId][utf friendlyName]
 *   [varint enabledFeatures][varint metricsHz][varint questHz][varint chunkHz][int64 serverTimeMillis]
 *   [varint negotiatedVersion]
 *   + optional [varint fixCount][utf fixId]*fixCount (enabledFixes)
 *
 * `accepted` is a plain 0/1 wire byte (NOT a varint). `serverTimeMillis` is written
 * as a big-endian int64. Always writes v2: feat-era (v1) mods reject a v2 ack and stay
 * unregistered — fine, none are deployed and they never enforced the policy anyway.
 *
 * The enabledFixes tail rides v2 with no version bump. Older mod decoders reject a version
 * above 2. They ignore trailing bytes. An empty list writes no tail, so the bytes match the old
 * layout. The mod reads a missing tail as "no fixes".
 */
export function encodeRegAck(ack: RegAck): Buffer {
  const w = new Writer()
    .varInt(2)
    .byte(ack.accepted ? 1 : 0)
    .utf(ack.canonicalServerId)
    .utf(ack.friendlyName)
    .varInt(ack.enabledFeatures)
    .varInt(ack.metricsHz)
    .varInt(ack.questHz)
    .varInt(ack.chunkHz)
    .long(BigInt(ack.serverTimeMillis))
    .varInt(ack.negotiatedVersion);
  const fixes = ack.enabledFixes ?? [];
  if (fixes.length > 0) {
    w.varInt(fixes.length);
    for (const id of fixes) w.utf(id);
  }
  return w.build();
}


// ── Ops + presence (JSON payloads per D7 — Gson mod-side, ≤20-char channels) ──

/**
 * `biforesting:op` (DOWN) and `biforesting:op_res` / `biforesting:presence` (UP) all share the
 * same envelope: `[varint ver=1][utf json]`. JSON keeps the op payload schema-free across the
 * four mod trees (Gson ships with MC on every target incl. 1.7.10).
 */
export function encodeJsonPayload(json: string): Buffer {
  return new Writer().varInt(1).utf(json).build();
}

/**
 * v2 op envelope: `[varint 2][utf json][varint blobLen][blob]`. The mod's `WireIO.MAX_STR` caps
 * the JSON string at 64 KB, so an op that must carry bytes (restore_inventory's gzipped snapshot
 * NBT, up to 256 KB) cannot base64 them into the JSON — they ride alongside as raw bytes.
 */
export function encodeJsonPayloadWithBlob(json: string, blob: Buffer): Buffer {
  const w = new Writer().varInt(2).utf(json).varInt(blob.length);
  return Buffer.concat([w.build(), blob]);
}

export function decodeJsonPayload(payload: Buffer): unknown {
  const r = new Reader(payload);
  r.varInt(); // version
  return JSON.parse(r.utf());
}

export function decodeOpRes(payload: Buffer): OpResMsg {
  const raw = decodeJsonPayload(payload) as Record<string, unknown>;
  if (typeof raw['opId'] !== 'string' || (raw['phase'] !== 'ack' && raw['phase'] !== 'result')) {
    throw new Error('malformed op_res: opId/phase missing');
  }
  return raw as unknown as OpResMsg;
}

export function decodePresence(payload: Buffer): PresenceMsg {
  const raw = decodeJsonPayload(payload) as Record<string, unknown>;
  const event = raw['event'];
  if (event !== 'join' && event !== 'quit' && event !== 'snapshot') {
    throw new Error('malformed presence: unknown event');
  }
  return {
    event,
    player: (raw['player'] as PresenceMsg['player']) ?? null,
    online: (raw['online'] as PresenceMsg['online']) ?? null,
  };
}

/** `biforesting:invsnap`: [varint ver=1][utf json header][varint gzLen][gz bytes]. */
export function decodeInvSnap(payload: Buffer): { header: InvSnapHeader; gz: Buffer } {
  const r = new Reader(payload);
  const version = r.varInt();
  if (version !== 1) throw new Error(`unsupported invsnap version ${version}`);
  const raw = JSON.parse(r.utf()) as Record<string, unknown>;
  if (typeof raw['uuid'] !== 'string' || typeof raw['name'] !== 'string') {
    throw new Error('malformed invsnap header');
  }
  const gzLen = r.varInt();
  const gz = r.bytes(gzLen);
  return {
    header: {
      uuid: raw['uuid'],
      name: raw['name'],
      reason: typeof raw['reason'] === 'string' ? raw['reason'] : 'unknown',
      dim: typeof raw['dim'] === 'string' ? raw['dim'] : '',
      pos: Array.isArray(raw['pos']) ? (raw['pos'] as number[]) : [],
      dataVersion: typeof raw['dataVersion'] === 'number' ? raw['dataVersion'] : 0,
      items: Array.isArray(raw['items']) ? (raw['items'] as InvSnapHeader['items']) : [],
    },
    gz,
  };
}

/** Cap of one syncsnap gz blob. The mod's own cap (`maxBlobBytes`) defaults to 2 MiB. */
export const SYNCSNAP_MAX_GZ_BYTES = 8 * 1024 * 1024;

const SYNC_SNAP_KINDS: readonly SyncSnapKind[] = ['shadow', 'release', 'pre_sync', 'pre_action', 'party_export'];

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `biforesting:syncsnap` (player-sync spec 3.4): [varint ver=1][utf header json][varint gzLen][gz].
 * The gz blob stays opaque: Node checks its length and sha256, never its NBT. Throws on a bad
 * field, so the caller logs and drops the message.
 */
export function decodeSyncSnap(payload: Buffer): DecodedSyncSnap {
  const r = new Reader(payload);
  const version = r.varInt();
  if (version !== 1) throw new Error(`unsupported syncsnap version ${version}`);
  const raw: unknown = JSON.parse(r.utf());
  if (!isRecord(raw)) throw new Error('malformed syncsnap header');
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !SYNC_SNAP_KINDS.includes(kind as SyncSnapKind)) {
    throw new Error(`syncsnap kind ${String(kind)} is unknown`);
  }
  const uuid = raw['uuid'];
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) throw new Error('syncsnap uuid is missing or malformed');
  const v = raw['v'];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error('syncsnap v is not a version number');
  const sha256 = raw['sha256'];
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) throw new Error('syncsnap sha256 is missing');

  const gzLen = r.varInt();
  if (gzLen < 0 || gzLen > SYNCSNAP_MAX_GZ_BYTES) {
    throw new Error(`syncsnap gzLen ${gzLen} is outside 0..${SYNCSNAP_MAX_GZ_BYTES}`);
  }
  if (gzLen !== r.remaining()) throw new Error(`syncsnap gzLen ${gzLen} != ${r.remaining()} bytes present`);
  const headerGzLen = raw['gzLen'];
  if (headerGzLen !== undefined && headerGzLen !== gzLen) {
    throw new Error(`syncsnap header gzLen ${String(headerGzLen)} != wire gzLen ${gzLen}`);
  }
  const gz = r.bytes(gzLen);
  if (createHash('sha256').update(gz).digest('hex') !== sha256.toLowerCase()) {
    throw new Error('syncsnap sha256 does not match the gz bytes');
  }

  const header: SyncSnapHeader = {
    kind: kind as SyncSnapKind,
    uuid: uuid.toLowerCase(),
    name: typeof raw['name'] === 'string' ? raw['name'] : '',
    v,
    sha256: sha256.toLowerCase(),
    gzLen,
    blocked: records(raw['blocked']).map(
      (e): SyncBlockedEntry => ({
        where: text(e['where']),
        slot: text(e['slot']),
        id: text(e['id']),
        reason: text(e['reason']) || 'block',
        ...(typeof e['detail'] === 'string' ? { detail: e['detail'] } : {}),
      }),
    ),
    links: records(raw['links']).map(
      (e): SyncLinkEntry => ({ where: text(e['where']), slot: text(e['slot']), id: text(e['id']), component: text(e['component']) }),
    ),
    worldData: records(raw['worldData']).map(
      (e): SyncWorldDataEntry => ({ h: text(e['h']), key: text(e['key']), ...pickNumbers(e, ['rawLen'] as const) }),
    ),
    playerData: Array.isArray(raw['playerData']) ? raw['playerData'].filter((p): p is string => typeof p === 'string') : [],
    ...pickNumbers(raw, ['dv', 'rawLen', 'tookMs', 'at'] as const),
  };
  for (const k of ['group', 'moveId', 'fp', 'action', 'backupId'] as const) {
    const s = raw[k];
    if (typeof s === 'string' && s.length > 0) header[k] = s;
  }
  return { header, gz };
}

/**
 * The entries of a header list. A non-object entry becomes an empty record, so a malformed
 * `blocked` entry still counts as blocked.
 */
function records(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? v.map((e) => (isRecord(e) ? e : {})) : [];
}

/** A string or number field as text. The mod may send a slot index as a number. */
function text(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

/**
 * `biforesting:questreg`: [varint ver=1][varint gzLen][gz utf8-json] — the gz JSON is
 * `{source, count, quests:[{id, chapter, chapterTitle, title, subtitle, taskCount, tasks[]}]}`.
 * Packs ship thousands of quests, so the registry always travels compressed.
 */
export function decodeQuestReg(payload: Buffer): QuestRegPayload {
  const r = new Reader(payload);
  const version = r.varInt();
  if (version !== 1) throw new Error(`unsupported questreg version ${version}`);
  const gzLen = r.varInt();
  const gz = r.bytes(gzLen);
  // Bounded inflate — see decodeItemRegistry. 32MB ≈ 300× the largest observed quest dump.
  const raw = JSON.parse(gunzipSync(gz, { maxOutputLength: 32 * 1024 * 1024 }).toString('utf8')) as Record<string, unknown>;
  const rows = Array.isArray(raw['quests']) ? (raw['quests'] as Array<Record<string, unknown>>) : [];
  const quests: QuestRegRow[] = rows
    .filter((q) => typeof q['id'] === 'string' && q['id'].length > 0)
    .map((q) => ({
      id: q['id'] as string,
      chapter: typeof q['chapter'] === 'string' ? q['chapter'] : '',
      chapterTitle: typeof q['chapterTitle'] === 'string' ? q['chapterTitle'] : '',
      title: typeof q['title'] === 'string' ? q['title'] : '',
      subtitle: typeof q['subtitle'] === 'string' ? q['subtitle'] : '',
      taskCount: typeof q['taskCount'] === 'number' ? q['taskCount'] : 0,
      tasks: Array.isArray(q['tasks']) ? (q['tasks'] as string[]) : [],
    }));
  return {
    source: typeof raw['source'] === 'string' ? raw['source'] : 'unknown',
    count: typeof raw['count'] === 'number' ? raw['count'] : quests.length,
    quests,
  };
}

export function encodeQuestDown(teams: QuestTeam[]): Buffer {
  const w = new Writer().varInt(1).varInt(teams.length);
  for (const t of teams) {
    w.utf(t.teamId).varInt(t.dataVersion).utf(t.snbt);
  }
  return w.build();
}

export function encodeChunksDown(teams: ChunkTeam[]): Buffer {
  const w = new Writer().varInt(1).varInt(teams.length);
  for (const t of teams) {
    w.utf(t.teamId).varInt(t.claims.length);
    for (const c of t.claims) {
      w.utf(c.dimension).varInt(c.x).varInt(c.z).bool(c.force);
    }
  }
  return w.build();
}
