import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import type { UpdateFilter } from 'mongodb';
import { eventBus } from '../../core/event-bus/index.js';
import { logger } from '../../core/logger/index.js';
import { AppError, NotFoundError } from '../../shared/errors/index.js';
import { catalogEntry, SYNC_DISOWN_MAX_ENTRIES, SYNC_LOCK_MAX_ENTRIES, SYNC_OWN_MAX_ENTRIES } from '../../domains/biforesting/ops-catalog.js';
import { FEATURE_BITS } from './policy-store.js';
import { ulid } from './ulid.js';
import {
  ledgerId,
  questLockHeld,
  toSyncStamp,
  type PresenceEvent,
  type SyncLedgerStore,
  type SyncPlayerDoc,
  type SyncPlayerState,
} from './sync-ledger-store.js';
import { syncSnapshotId, type SyncSnapshotMeta, type SyncSnapshotStore } from './sync-snapshot-store.js';
import {
  type MoveCode,
  type MoveOutcome,
  type MoveStep,
  type MoveStepRecord,
  type SyncGateEntry,
  type SyncMoveDoc,
  type SyncMovesStore,
} from './sync-moves-store.js';
import type { SyncGroupDoc, SyncGroupsStore } from './sync-groups-store.js';
import type { SyncWorldDataDoc, SyncWorldDataStore } from './sync-worlddata-store.js';
import type { OpsStore } from './ops-store.js';
import type { GroupMember } from './server-resolver.js';
import type { SyncAt, SyncDirectory, SyncLinkPort, SyncLiveHooks } from './sync-service.js';
import type { OpDoc, OpTarget, PresencePlayer, SyncBlockedEntry, SyncStamp } from './types.js';

/**
 * Player sync S2 and S3 on the Yggdrasil side (bifrost-lib `docs/invariants/player-sync.md`
 * sections 3.5, 5, 6 and 7): the move runner, the detector, disown reconcile and world-data locks.
 *
 * A move is a state machine over two docs. The ledger doc (`biforesting_sync_players`) holds the
 * owner, the version and the open move. The move doc (`biforesting_sync_moves`) holds the op of
 * each step, retry counts and the probe in flight. Every ledger write is a CAS on `_id`, `state`,
 * `move.id` and the lease (the Bifrost trade settlement pattern). The runner holds the lease of
 * every open move it drives and renews it at a third of {@link SyncTiming.leaseMs}.
 *
 *   online(A,n) -> moving{prepare} -> moving{wait_quit} -> moving{release}
 *     -> applying(owner null, n+1){apply} -> online(B,n+1), then sync_commit to A
 *   any step before apply ends -> abort -> online(A, n or n+1), then sync_abort to A
 *   force-release: applying{disown} (kick and disown every old copy) -> applying{apply} -> online(to)
 *   reseed of a restored instance: its moves close, its owned docs trust the disk and get a
 *   `sync_own`, its disowns run again, and the world data of other owners gets a `sync_lock`
 *
 * Op updates, presence events, link-ups and a 15 s sweep drive the moves. One op per player is
 * in flight at a time. An uncertain op outcome is resolved with a `sync_probe`, never by trusting
 * the op doc. Moves of one process run one at a time per move id; one Yggdrasil process is the
 * assumption, and the lease guards against a second one.
 */

const PLAYER_SYNC = FEATURE_BITS['player_sync']!;

/** Op settings for every sync op (spec 6.2). */
export const SYNC_OP_DEFAULTS = {
  execTimeoutMs: 120_000,
  maxAttempts: 10,
  expiresInMs: 7 * 24 * 3600_000,
} as const;

export interface SyncTiming {
  /** A lease lasts this long without renewal. Renewal runs at a third of it. */
  leaseMs: number;
  /** A prepare with no result after this aborts with `timeout`. */
  prepareMs: number;
  /** A player still online on the source after this aborts with `player_online`. */
  waitQuitMs: number;
  /** The release starts this long after a prepare that found the player offline. */
  releaseDelayMs: number;
  sweepMs: number;
}

export const DEFAULT_SYNC_TIMING: SyncTiming = {
  leaseMs: 30_000,
  prepareMs: 10_000,
  waitQuitMs: 60_000,
  releaseDelayMs: 3_000,
  sweepMs: 15_000,
};

const MAX_RELEASE_ATTEMPTS = 3;
/** The first apply plus one retry (spec 6.1). */
const MAX_APPLY_ATTEMPTS = 2;
const MAX_FINAL_ATTEMPTS = 5;
const MAX_PROBES = 5;
/** Key step of the `sync_probe` to the target at move start: `sync:<group>:<uuid>:<moveId>:target-probe`. */
const TARGET_PROBE = 'target-probe';

/** Result codes that prove the op changed nothing (spec 3.5, plus the mod executor's own). */
const CHANGED_NOTHING: ReadonlySet<string> = new Set([
  'not_applied',
  'unsupported_op',
  'blocked',
  'player_online',
  'player_offline',
  'fingerprint_mismatch',
  'stale_version',
  'guard_busy',
  'no_dat',
  'too_large',
  'bad_blob',
  'self_check_failed',
  'save_failed',
  // The mod answers these two before it runs the op: the bit is off, or sync is inert there.
  'feature_off',
  'inert',
  // A per-player file the mod cannot read (contract-notes-mod F8). It does not fix itself, so no retry.
  'cosarmor_unreadable',
  'advancements_unreadable',
]);
/** Changed-nothing codes that the move keeps as its own code, so the player line can name the file. */
const UNREADABLE_CODES: ReadonlySet<string> = new Set(['cosarmor_unreadable', 'advancements_unreadable']);

/** `code` as a move code when it names an unreadable player file, else null. */
function unreadableCode(code: string): MoveCode | null {
  return UNREADABLE_CODES.has(code) ? (code as MoveCode) : null;
}
const RELEASE_RETRY_CODES: ReadonlySet<string> = new Set(['not_applied', 'guard_busy']);
/** The error text of an inert answer from a mod build that predates the `inert` code. */
const INERT_ERROR = /player sync is inert/i;

/** Player-facing lines (spec 7). */
export const SYNC_MESSAGES = {
  paused: 'Moving between instances is paused right now.',
  fingerprint: 'The instances run different pack versions right now. Try again after the update.',
  stuck: 'Your character needs staff help to move. Open a ticket.',
  moving: 'Your character is moving to another instance. Join again in a few seconds.',
  busy: 'Your character is already moving. Try again in a few seconds.',
  staff: 'Staff are moving your character. Join again in a minute.',
  questsBusy: 'Your quest book is being changed right now. Try again in a few seconds.',
  cosarmorUnreadable: 'Your cosmetic armour data cannot be read.',
  advancementsUnreadable: 'Your advancements cannot be read.',
} as const;

/** A refused move start. The body is `{error: {code, message, details}}`; Bifrost shows `message`. */
export class SyncConflictError extends AppError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message, 409, code, details);
  }
}

// ── Op outcome classes ───────────────────────────────────────────────────────

export type OpClass =
  | { kind: 'applied'; op: OpDoc }
  | { kind: 'not_applied'; code: string; op: OpDoc }
  | { kind: 'unknown'; op: OpDoc }
  | { kind: 'wait'; op: OpDoc };

/**
 * True when no dispatch of this op can have reached the mod. A dispatch whose link write failed
 * (the eager requeue right after it) never left Yggdrasil. A `waiting_player` answer means the
 * mod ran nothing.
 */
export function provablyUnrun(op: Pick<OpDoc, 'attempts' | 'audit'>): boolean {
  if (op.attempts === 0) return true;
  const audit = op.audit ?? [];
  let mayHaveRun = false;
  for (let i = 0; i < audit.length; i++) {
    const entry = audit[i]!;
    if (entry.to === 'dispatched') {
      const next = audit[i + 1];
      const neverSent = next?.to === 'pending' && next.note?.startsWith('link not writable') === true;
      if (!neverSent) mayHaveRun = true;
    } else if (entry.to === 'waiting_player') {
      mayHaveRun = false;
    }
  }
  return !mayHaveRun;
}

export function classifyOp(op: OpDoc): OpClass {
  switch (op.state) {
    case 'completed':
      return { kind: 'applied', op };
    case 'failed': {
      const code = op.result?.code;
      if (code && CHANGED_NOTHING.has(code)) return { kind: 'not_applied', code, op };
      return provablyUnrun(op) ? { kind: 'not_applied', code: code ?? 'not_applied', op } : { kind: 'unknown', op };
    }
    case 'expired':
    case 'cancelled':
      return provablyUnrun(op) ? { kind: 'not_applied', code: 'not_applied', op } : { kind: 'unknown', op };
    default:
      return { kind: 'wait', op };
  }
}

function isPreAck(op: OpDoc): boolean {
  return op.state === 'pending' || op.state === 'dispatched' || op.state === 'waiting_player';
}

export type NoVerdict = 'feature_off' | 'no_link' | 'inert';

/**
 * Why an op ended without a verdict from the mod, or null when the mod answered it. `feature_off`:
 * the dispatcher failed it, the player_sync bit is off. `inert`: the mod's sync config is invalid.
 * `no_link`: it expired, or failed with no ack and no code. For the final ops (abort, commit,
 * re-apply, disown) such a failure does not count against the retry limit.
 */
export function noVerdict(op: OpDoc): NoVerdict | null {
  if (op.state === 'expired') return 'no_link';
  if (op.state !== 'failed') return null;
  const code = op.result?.code;
  if (code === 'feature_off') return 'feature_off';
  if (code === 'inert') return 'inert';
  if (code === 'not_applied' && INERT_ERROR.test(op.result?.error ?? '')) return 'inert';
  if (code === undefined && op.ackedAt === null) return 'no_link';
  return null;
}

/** The state of a final op. `parked`: no verdict, and nothing says the instance can take it now. */
type FinalState =
  | { kind: 'wait' }
  | { kind: 'done' }
  | { kind: 'parked'; why: NoVerdict }
  | { kind: 'retry'; uncounted: boolean; why: string }
  | { kind: 'exhausted' };

/** The op result body. The mod leaves out null keys, so a missing key reads as absent. */
function resultData(op: OpDoc | null): Record<string, unknown> {
  const d = op?.result?.data;
  return d !== null && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

function blockedOf(op: OpDoc): SyncBlockedEntry[] {
  const raw = resultData(op)['blocked'];
  if (!Array.isArray(raw)) return [];
  return raw.map((e) => {
    const r = e !== null && typeof e === 'object' ? (e as Record<string, unknown>) : {};
    return {
      where: text(r['where']),
      slot: text(r['slot']),
      id: text(r['id']),
      reason: text(r['reason']) || 'block',
      ...(typeof r['detail'] === 'string' ? { detail: r['detail'] } : {}),
    };
  });
}

/** `[{h, key}]` from a release result or header, without duplicates. */
function worldDataOf(...lists: unknown[]): Array<{ h: string; key: string }> {
  const seen = new Map<string, { h: string; key: string }>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      const r = e !== null && typeof e === 'object' ? (e as Record<string, unknown>) : {};
      if (typeof r['h'] === 'string' && r['h'] !== '' && typeof r['key'] === 'string' && r['key'] !== '') {
        seen.set(`${r['h']}:${r['key']}`, { h: r['h'], key: r['key'] });
      }
    }
  }
  return [...seen.values()];
}

function describe(op: OpDoc): string {
  const error = op.result?.error;
  return `${op.result?.code ?? op.state}${error ? `: ${error}` : ''}`;
}

/** The `{u, ...}` entries of a `sync_disown` or `sync_own` op. */
function opEntries(op: OpDoc): Array<{ u: string }> {
  const raw = op.params['entries'];
  return Array.isArray(raw) ? raw.filter((e): e is { u: string } => typeof (e as { u?: unknown })?.u === 'string') : [];
}

/** The `{h, key}` entries of a `sync_lock` op. */
function lockEntries(op: OpDoc): Array<{ h: string; key: string }> {
  return worldDataOf(op.params['entries']);
}

/** Group and serverId of a batch op key, `sync:<group>:<kind>:<serverId>:<batchId>`; null for another key. */
function batchTarget(op: OpDoc, kind: 'disown' | 'own' | 'lock'): { group: string; serverId: string } | null {
  const group = op.params['group'];
  const key = op.idempotencyKey ?? '';
  if (typeof group !== 'string') return null;
  const prefix = `sync:${group}:${kind}:`;
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const serverId = rest.slice(0, rest.lastIndexOf(':'));
  return serverId ? { group, serverId } : null;
}

/** The batch id at the end of a `sync_disown` key, `sync:<group>:disown:<serverId>:<batchId>`. */
function disownBatchOf(op: OpDoc): string | null {
  const key = op.idempotencyKey ?? '';
  if (!key.includes(':disown:')) return null;
  return key.slice(key.lastIndexOf(':') + 1) || null;
}

/** The move id in the key of a target probe, or null for any other op. */
function targetProbeMoveOf(op: OpDoc): string | null {
  const key = op.idempotencyKey ?? '';
  const suffix = `:${TARGET_PROBE}`;
  if (op.type !== 'sync_probe' || !key.endsWith(suffix)) return null;
  const head = key.slice(0, -suffix.length);
  return head.slice(head.lastIndexOf(':') + 1) || null;
}

/** The `away` entry of a probe result, or null. */
function awayOf(raw: unknown): { v: number; m: string } | null {
  if (raw === null || typeof raw !== 'object') return null;
  const { v, m } = raw as Record<string, unknown>;
  return typeof m === 'string' ? { v: typeof v === 'number' ? v : -1, m } : null;
}

// ── Labels and player-facing messages ────────────────────────────────────────

/** "Instance <n>" from the group members, else the server name, else the serverId. */
export function instanceLabel(members: GroupMember[], serverId: string | null): string {
  if (!serverId) return 'another instance';
  const m = members.find((x) => x.serverId === serverId);
  if (m?.instanceNumber) return `Instance ${m.instanceNumber}`;
  return m?.name || serverId;
}

function blockedList(blocked: SyncBlockedEntry[]): string {
  const ids = [...new Set(blocked.map((b) => b.id).filter((id) => id !== ''))];
  if (ids.length === 0) return 'some items';
  return ids.length <= 8 ? ids.join(', ') : `${ids.slice(0, 8).join(', ')} and ${ids.length - 8} more`;
}

export function moveMessage(move: SyncMoveDoc, members: GroupMember[]): string {
  const from = instanceLabel(members, move.from);
  const to = instanceLabel(members, move.to);
  switch (move.outcome) {
    case 'committed':
      return `Your character is now on ${to}.`;
    case 'stuck':
      return SYNC_MESSAGES.stuck;
    case 'aborted':
    case 'cancelled':
      switch (move.code) {
        case 'blocked':
          return `These items cannot travel: ${blockedList(move.blocked)}. Leave them on ${from}, then try again.`;
        case 'fingerprint_mismatch':
          return SYNC_MESSAGES.fingerprint;
        case 'timeout':
          return `The move took too long. Your character stays on ${from}. Try again.`;
        case 'player_online':
          return `You were still online on ${from}, so the move stopped. Try again.`;
        case 'cosarmor_unreadable':
          return `${SYNC_MESSAGES.cosarmorUnreadable} Your character stays on ${from}. Open a ticket so staff can fix it.`;
        case 'advancements_unreadable':
          return `${SYNC_MESSAGES.advancementsUnreadable} Your character stays on ${from}. Open a ticket so staff can fix it.`;
        case 'cancelled':
          return move.error?.code === 'mode_off'
            ? `${SYNC_MESSAGES.paused} Your character stays on ${from}.`
            : `The move was cancelled. Your character stays on ${from}.`;
        default:
          return `The move failed. Your character stays on ${from}. Try again later.`;
      }
    default:
      return move.step === 'prepare'
        ? `Getting your character ready to move to ${to}.`
        : `Moving your character to ${to}. Join again in a few seconds.`;
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────────

export interface SyncRunnerDirectory extends SyncDirectory {
  /** The instanceKey of a Pterodactyl serverId (the server resolver), or null when unknown. */
  instanceOf(serverId: string): Promise<{ instanceKey: string; tag: string | null } | null>;
}

export interface SyncRunnerStores {
  groups: SyncGroupsStore;
  ledger: SyncLedgerStore;
  snapshots: SyncSnapshotStore;
  moves: SyncMovesStore;
  worldData: SyncWorldDataStore;
}

export interface SyncRunnerDeps {
  stores: SyncRunnerStores;
  ops: Pick<OpsStore, 'create' | 'get' | 'cancel' | 'listOpen'>;
  /** Dispatches a new op (the op dispatcher). */
  dispatch: { onOpCreated(op: OpDoc): Promise<void> };
  directory: SyncRunnerDirectory;
  links: SyncLinkPort;
  /** Lease holder id. Default: host, pid and a random part. */
  holder?: string;
  now?: () => number;
  timing?: Partial<SyncTiming>;
  /** Runs `fn` after `ms`. Tests pass a no-op and drive the sweep. */
  schedule?: (fn: () => void, ms: number) => void;
}

/** One move as REST shows it. No blobs. */
export interface SyncMoveView {
  id: string;
  group: string;
  uuid: string;
  name: string;
  kind: SyncMoveDoc['kind'];
  from: string | null;
  to: string;
  vFrom: number;
  vTo: number;
  step: MoveStep;
  outcome: MoveOutcome | null;
  code: MoveCode | null;
  /** The ledger owner and version now. */
  owner: string | null;
  version: number | null;
  message: string;
  blocked?: SyncBlockedEntry[];
  /**
   * The target held an independent character of the player at move start: a `.dat` with no stamp
   * of this group. Null until the target probe answers.
   */
  targetHasCharacter: boolean | null;
  error: { code: string; message: string } | null;
  actor: string;
  reason: string | null;
  startedAt: Date;
  endedAt: Date | null;
}

/** POST /sync/:group/reseed (spec 6.7). */
export interface SyncReseedResult {
  group: string;
  serverId: string;
  /** Open moves that touch the server and closed before their apply went out. */
  movesAborted: string[];
  /** Open moves that touch the server and went stuck: their apply went out. */
  movesStuck: string[];
  /** Online ledger docs the server owns. Each now has `trustDisk`. */
  trusted: number;
  /** Players that another member owns. Their disown to the server is queued, or waits for its link. */
  disownsQueued: number;
  /** `sync_disown` ops created by this call. 0 while the server has no link with player_sync. */
  disownBatches: number;
  /**
   * `sync_own` ops created by this call for the docs the server owns. 0 while the server has no
   * link with player_sync; its next register queues them.
   */
  ownBatches: number;
  /**
   * `sync_lock` ops created by this call for the world-data records that another instance owns or
   * that are in transit. 0 outside live mode, and while the server has no link with player_sync;
   * its next register queues them.
   */
  lockBatches: number;
}

export interface MoveStartInput {
  from: string;
  to: string;
  name?: string | undefined;
  reason?: string | undefined;
  /** Staff move: the group cooldown does not apply. */
  skipCooldown?: boolean | undefined;
  actor: string;
}

type StepSet = Record<string, unknown>;
/** `away`: the probed instance still marks the player away for move `m`. */
type ProbeAnswer = 'pending' | 'progress' | 'exhausted' | { applied: boolean; away: { v: number; m: string } | null };

export class SyncRunner implements SyncLiveHooks {
  readonly holder: string;
  private readonly now: () => number;
  private readonly timing: SyncTiming;
  private readonly schedule: (fn: () => void, ms: number) => void;
  /** One drive per move id at a time. A kick during a drive runs it once more after. */
  private readonly running = new Map<string, Promise<void>>();
  private readonly rerun = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  /** Long-poll waiters, keyed by move id. */
  private readonly changes = new EventEmitter();
  private sweepTimer: NodeJS.Timeout | null = null;
  private renewTimer: NodeJS.Timeout | null = null;
  /** False after a sweep found nothing open. With every group off, the sweep then reads nothing. */
  private awake = true;
  /** True once this process holds a lease. Lease renewal writes nothing before that. */
  private leased = false;
  /** Per serverId: link-ups and reg_acks with player_sync seen by this process. */
  private readonly linkEpoch = new Map<string, number>();
  /** Per parked final op id: the {@link linkEpoch} of its instance when it was parked. */
  private readonly parkedAt = new Map<string, number>();
  /** Per `<group>:<serverId>`: `sync_lock` failures with a verdict since the last link-up or completion. */
  private readonly lockFailures = new Map<string, number>();

  constructor(private readonly deps: SyncRunnerDeps) {
    this.holder = deps.holder ?? `${hostname()}:${process.pid}:${ulid()}`;
    this.now = deps.now ?? Date.now;
    this.timing = { ...DEFAULT_SYNC_TIMING, ...(deps.timing ?? {}) };
    this.schedule =
      deps.schedule ??
      ((fn, ms): void => {
        setTimeout(fn, ms).unref();
      });
    this.changes.setMaxListeners(0);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((err) => logger.warn({ err }, 'biforesting-sync: sweep failed'));
    }, this.timing.sweepMs);
    this.sweepTimer.unref();
    this.renewTimer = setInterval(() => {
      void this.renewLeases().catch((err) => logger.warn({ err }, 'biforesting-sync: lease renewal failed'));
    }, Math.floor(this.timing.leaseMs / 3));
    this.renewTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.sweepTimer = null;
    this.renewTimer = null;
  }

  /** Resolves when no drive and no background task runs (tests). */
  async idle(): Promise<void> {
    for (let i = 0; i < 1000; i++) {
      const pending = [...this.running.values(), ...this.tasks];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /**
   * Every 15 s: drive each open move (deadlines, retries, probes), and put back a ledger doc
   * whose move doc never got written. Lapsed leases of a dead process are taken here.
   */
  async sweep(): Promise<number> {
    if (!this.awake) return 0;
    const { moves, ledger } = this.deps.stores;
    const open = await moves.listOpen();
    const lapsed = await ledger.listLapsed(new Date(this.now()));
    const openIds = new Set(open.map((m) => m._id));
    for (const doc of lapsed) {
      const moveId = doc.move?.id;
      if (moveId && !openIds.has(moveId) && !(await moves.get(moveId))) await this.dropMissingMove(doc);
    }
    if (open.length === 0 && lapsed.length === 0) {
      this.awake = false;
      this.leased = false;
      return 0;
    }
    await Promise.all(open.map((m) => this.kick(m._id)));
    return open.length;
  }

  async renewLeases(): Promise<void> {
    if (!this.awake || !this.leased) return;
    await this.deps.stores.ledger.renewLeases(this.holder, new Date(this.now() + this.timing.leaseMs));
  }

  // ── Hooks ──────────────────────────────────────────────────────────────────

  /** The op dispatcher update hook. Non-sync ops return at once. */
  onOpUpdate(op: OpDoc): Promise<void> {
    if (!op.type.startsWith('sync_')) return Promise.resolve();
    return this.track(this.routeOpUpdate(op));
  }

  /** Live mode presence (spec 6.1 and 6.4). A quit drives the move, a join runs the detector. */
  async onPresence(at: SyncAt, event: PresenceEvent, player: PresencePlayer, stamp: SyncStamp | null, doc: SyncPlayerDoc | null): Promise<void> {
    if (event === 'quit') {
      const move = doc?.move;
      const quitFromSource = move?.from === at.serverId && (move.step === 'prepare' || move.step === 'wait_quit');
      if (move && (quitFromSource || move.step === 'disown')) await this.kick(move.id);
      return;
    }
    await this.detect(at, player, stamp, doc);
  }

  /**
   * A stored `release` syncsnap. It never advances a ledger by itself: the release op result
   * does, after its receipt check. This only logs an upload that no open release explains.
   */
  async onReleaseSnapshot(at: SyncAt, snap: SyncSnapshotMeta): Promise<void> {
    const move = (await this.deps.stores.ledger.get(at.group, snap.uuid))?.move ?? null;
    if (move && move.id === snap.moveId && move.from === at.serverId && move.step === 'release') return;
    logger.warn(
      { group: at.group, serverId: at.serverId, uuid: snap.uuid, moveId: snap.moveId, snapshotId: snap._id, ledgerMove: move },
      'biforesting-sync: release snapshot stored, but no open release of this server explains it; it advances nothing',
    );
  }

  /**
   * A member registered or got a re-sent reg_ack. With player_sync granted, final ops parked on
   * it may run again. In a live group its disowns, owns and world-data locks are reconciled. Then
   * its open moves are driven.
   */
  async onMemberLinkUp(group: string, serverId: string, live = true): Promise<void> {
    const link = await this.deps.links.instance(serverId);
    if (link && (link.grantedFeatures & PLAYER_SYNC) !== 0) this.linkEpoch.set(serverId, (this.linkEpoch.get(serverId) ?? 0) + 1);
    if (live) {
      await this.reconcileDisowns(group, serverId);
      await this.reconcileOwns(group, serverId);
      this.lockFailures.delete(`${group}:${serverId}`);
      await this.reconcileLocks(group, serverId);
    }
    if (!this.awake) return;
    for (const m of await this.deps.stores.moves.listOpen()) {
      if (m.group === group && (m.from === serverId || m.to === serverId || m.disownTo.includes(serverId))) await this.kick(m._id);
    }
  }

  /** PUT /sync/:group (spec 6.6). Into live: reconcile disowns and owns. Out of live: stop moves before apply. */
  async onGroupUpdated(group: string, before: SyncGroupDoc, after: SyncGroupDoc): Promise<void> {
    if (before.mode !== 'live' && after.mode === 'live') {
      this.awake = true;
      for (const m of await this.deps.directory.groupMembers(group)) {
        await this.reconcileDisowns(group, m.serverId);
        await this.reconcileOwns(group, m.serverId);
        await this.reconcileLocks(group, m.serverId);
      }
    }
    if (before.mode === 'live' && after.mode !== 'live') {
      const at = new Date(this.now());
      for (const m of await this.deps.stores.moves.listOpen()) {
        if (m.group !== group || m.outcome !== null) continue;
        if (await this.deps.stores.moves.requestCancel(m._id, { by: 'mode', reason: 'mode_off', at })) await this.kick(m._id);
      }
    }
  }

  // ── REST ───────────────────────────────────────────────────────────────────

  /** POST .../moves. Answers at step prepare; the prepare op runs after. */
  async startMove(group: string, rawUuid: string, input: MoveStartInput): Promise<SyncMoveView> {
    const uuid = rawUuid.toLowerCase();
    const { groups, ledger, moves } = this.deps.stores;
    const { from, to } = input;
    const g = await groups.get(group);
    const members = await this.deps.directory.groupMembers(group);
    const label = (s: string | null): string => instanceLabel(members, s);
    if (g.mode !== 'live') throw new SyncConflictError('mode_off', SYNC_MESSAGES.paused, { mode: g.mode });
    if (g.frozen) throw new SyncConflictError('frozen', SYNC_MESSAGES.paused, { freezeReason: g.freezeReason });
    for (const s of [from, to]) {
      if (!members.some((m) => m.serverId === s)) {
        throw new SyncConflictError('not_member', `That instance is not part of this pack.`, { serverId: s });
      }
    }

    const doc = await ledger.get(group, uuid);
    if (doc?.state === 'stuck') throw new SyncConflictError('moving', SYNC_MESSAGES.stuck, { state: doc.state, moveId: doc.move?.id ?? null });
    if (doc && (doc.state !== 'online' || doc.move)) {
      throw new SyncConflictError('moving', SYNC_MESSAGES.busy, { state: doc.state, moveId: doc.move?.id ?? null });
    }
    if (!doc || doc.owner !== from) {
      const message = doc?.owner ? `This character is on ${label(doc.owner)}.` : 'This character is on no instance yet. Join an instance first.';
      throw new SyncConflictError('not_owner', message, { owner: doc?.owner ?? null });
    }
    // A quest action or a party merge runs for this player. The CAS below would fail on its
    // lease too; this check only gives the player the right reason.
    if (questLockHeld(doc, this.now())) throw new SyncConflictError('moving', SYNC_MESSAGES.questsBusy, { questLock: true });

    const last = input.skipCooldown ? null : await moves.latestCommitted(group, uuid);
    if (last?.endedAt) {
      const left = last.endedAt.getTime() + g.cooldownMs - this.now();
      if (left > 0) {
        const minutes = Math.ceil(left / 60_000);
        throw new SyncConflictError('cooldown', `You can move again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, {
          minutesLeft: minutes,
          retryAt: new Date(this.now() + left),
        });
      }
    }

    const [a, b] = await Promise.all([this.deps.links.instance(from), this.deps.links.instance(to)]);
    for (const [s, link] of [[from, a], [to, b]] as const) {
      if (!link) throw new SyncConflictError('no_link', `${label(s)} is not reachable right now. Try again later.`, { serverId: s });
    }
    for (const [s, link] of [[from, a], [to, b]] as const) {
      if (((link?.grantedFeatures ?? 0) & PLAYER_SYNC) === 0) {
        throw new SyncConflictError('feature_off', `Moving is not open on ${label(s)} yet.`, { serverId: s });
      }
    }
    if (!a?.fp || a.fp !== b?.fp) {
      throw new SyncConflictError('fingerprint_mismatch', SYNC_MESSAGES.fingerprint, { from: a?.fp ?? null, to: b?.fp ?? null });
    }

    const now = new Date(this.now());
    const moveId = ulid(now.getTime());
    const _id = ledgerId(group, uuid);
    // The ledger CAS is the lock: of two starts for one player, exactly one wins here.
    const locked = await ledger.casUpdate(
      { _id, state: 'online', moveId: null, owner: from, version: doc.version, lease: { holder: this.holder, now } },
      {
        $set: {
          state: 'moving',
          move: { id: moveId, from, to, step: 'prepare', startedAt: now, updatedAt: now },
          lease: { holder: this.holder, until: new Date(now.getTime() + this.timing.leaseMs) },
        },
      },
    );
    if (!locked) throw new SyncConflictError('moving', SYNC_MESSAGES.busy, {});
    this.leased = true;

    const move = this.newMove({
      _id: moveId,
      group,
      uuid,
      name: input.name ?? doc.name,
      kind: 'move',
      from,
      to,
      vFrom: doc.version,
      vTo: doc.version + 1,
      actor: input.actor,
      reason: input.reason ?? null,
      step: 'prepare',
      now,
      deadlineAt: new Date(now.getTime() + this.timing.prepareMs),
    });
    try {
      await moves.insert(move);
    } catch (err) {
      await ledger.casUpdate({ _id, moveId, state: 'moving' }, { $set: { state: 'online', move: null, lease: null } });
      throw err;
    }
    this.awake = true;
    logger.info({ group, uuid, moveId, from, to, vFrom: move.vFrom, actor: input.actor }, 'biforesting-sync: move started');
    this.emitMove(move);
    await this.kick(moveId);
    // Spec 7: the 201 shows step prepare. A prepare result that came back during the kick may
    // have moved the doc on already; Bifrost's long poll with `step=prepare` sees that at once.
    return this.view(move, members);
  }

  async getMove(group: string, uuid: string, moveId: string): Promise<SyncMoveView> {
    return this.view(await this.findMove(group, uuid, moveId));
  }

  /**
   * GET .../moves/:moveId?waitMs. With `waitMs`, a long poll: it answers at the next change of
   * step or outcome, when the target probe answers, or at the timeout. A move with an outcome
   * answers at once. `knownStep` (the step the caller saw last) makes it answer at once when the
   * step moved on since; without it a change between two polls is missed. The waiters live in
   * this process: one Yggdrasil process is the assumption.
   */
  async waitMove(group: string, uuid: string, moveId: string, waitMs: number, knownStep?: MoveStep, signal?: AbortSignal): Promise<SyncMoveView> {
    // Listen before the read, so a change between the read and the wait still ends the wait.
    const wait = waitMs > 0 ? this.nextChange(moveId, waitMs, signal) : null;
    try {
      const move = await this.findMove(group, uuid, moveId);
      if (!wait || move.outcome !== null || (knownStep !== undefined && knownStep !== move.step)) return await this.view(move);
      await wait.promise;
      return await this.view(await this.findMove(group, uuid, moveId));
    } finally {
      wait?.cancel();
    }
  }

  /** POST .../moves/:moveId/cancel (spec 6.3). A move with an outcome comes back unchanged. */
  async cancelMove(group: string, uuid: string, moveId: string, actor: string): Promise<SyncMoveView> {
    const move = await this.findMove(group, uuid, moveId);
    if (move.outcome === null) {
      await this.deps.stores.moves.requestCancel(moveId, { by: actor, reason: 'staff', at: new Date(this.now()) });
      this.awake = true;
      await this.kick(moveId);
    }
    return this.view(await this.findMove(group, uuid, moveId));
  }

  /**
   * POST .../force-release (spec 6.3, staff). Applies a snapshot on `to` with version
   * `max(version, snapshot.v) + 1`. Every other instance that may hold a copy first gets a
   * `sync_kick` and a `sync_disown` (step `disown`); the apply waits for the disowns. On a failure
   * before any disown ran, the ledger goes back as it was; after that, it goes stuck.
   *
   * 409 `player_online` while presence shows the player online on another member and no kick
   * there has completed since. That kick goes out with the refusal, so a retry a few seconds later
   * passes. A dead member of a stuck ledger never blocks the call.
   */
  async forceRelease(group: string, rawUuid: string, input: { to: string; snapshotId?: string | undefined }, actor: string): Promise<SyncMoveView> {
    const uuid = rawUuid.toLowerCase();
    const { ledger, moves, snapshots } = this.deps.stores;
    const { to } = input;
    const members = await this.deps.directory.groupMembers(group);
    const isMember = (s: string | null): s is string => !!s && members.some((m) => m.serverId === s);
    if (!isMember(to)) throw new SyncConflictError('not_member', 'That instance is not part of this pack.', { serverId: to });
    const doc = await ledger.get(group, uuid);
    if (!doc) throw new NotFoundError('Sync player', `${group}:${uuid}`);
    if (doc.state === 'moving' || doc.state === 'applying') {
      throw new SyncConflictError('moving', 'The character is moving. Cancel the move first.', { moveId: doc.move?.id ?? null });
    }
    let snap: SyncSnapshotMeta | null;
    if (input.snapshotId) {
      snap = await snapshots.getMeta(input.snapshotId);
      if (!snap || snap.group !== group || snap.uuid !== uuid) throw new NotFoundError('Sync snapshot', input.snapshotId);
    } else {
      snap = await this.committedRelease(group, uuid);
      if (!snap) throw new SyncConflictError('no_snapshot', 'This player has no release snapshot of a committed move. Name one with snapshotId.', {});
    }

    const seen = doc.lastSeen;
    const seenOn = seen && seen.serverId !== to && isMember(seen.serverId) ? seen.serverId : null;
    if (seen && seenOn && seen.event !== 'quit') {
      const link = await this.deps.links.instance(seenOn);
      if (link || doc.state !== 'stuck') {
        const kick = link && (link.grantedFeatures & PLAYER_SYNC) !== 0 ? await this.onlineKick(group, uuid, doc.name, seenOn, seen.at, to, members, `sync:force-release (${actor})`) : null;
        if (kick?.state !== 'completed') {
          const where = instanceLabel(members, seenOn);
          throw new SyncConflictError(
            'player_online',
            kick ? `The player is online on ${where}. A kick is on its way. Try again in a few seconds.` : `The player is online on ${where}, and ${where} cannot kick them now.`,
            { serverId: seenOn, kick: kick ? { opId: kick._id, state: kick.state } : null },
          );
        }
      }
    }

    const old = doc.move ? await moves.get(doc.move.id) : null;
    const disownTo = [...new Set([doc.owner, old?.from ?? null, old?.to ?? null, seenOn])].filter((s): s is string => isMember(s) && s !== to);
    const now = new Date(this.now());
    const moveId = ulid(now.getTime());
    const vTo = Math.max(doc.version, snap.v) + 1;
    const locked = await ledger.casUpdate(
      { _id: doc._id, state: doc.state, moveId: doc.move?.id ?? null, version: doc.version, lease: { holder: this.holder, now } },
      {
        $set: {
          state: 'applying',
          owner: null,
          version: vTo,
          move: { id: moveId, from: doc.owner ?? '', to, step: 'disown', startedAt: now, updatedAt: now },
          lease: { holder: this.holder, until: new Date(now.getTime() + this.timing.leaseMs) },
        },
      },
    );
    if (!locked) throw new SyncConflictError('moving', SYNC_MESSAGES.busy, {});
    this.leased = true;

    const move: SyncMoveDoc = {
      ...this.newMove({
        _id: moveId,
        group,
        uuid,
        name: doc.name,
        kind: 'force_release',
        from: doc.owner,
        to,
        vFrom: doc.version,
        vTo,
        actor,
        reason: `force-release of snapshot ${snap._id}`,
        step: 'disown',
        now,
        deadlineAt: new Date(now.getTime() + SYNC_OP_DEFAULTS.expiresInMs),
      }),
      snapshotId: snap._id,
      sha256: snap.sha256,
      fp: snap.fp,
      worldData: worldDataOf(snap.header.worldData),
      before: { state: doc.state, owner: doc.owner, version: doc.version, move: doc.move },
      disownTo,
      gate: disownTo.map((serverId) => ({ serverId, kick: null, disown: null, attempts: 0, uncounted: 0, done: false })),
    };
    try {
      await moves.insert(move);
    } catch (err) {
      await ledger.casUpdate(
        { _id: doc._id, moveId, state: 'applying' },
        { $set: { state: doc.state, owner: doc.owner, version: doc.version, move: doc.move, lease: null } },
      );
      throw err;
    }
    this.awake = true;
    logger.warn({ group, uuid, moveId, to, snapshotId: snap._id, vTo, actor, disownTo }, 'biforesting-sync: force-release started');
    this.emitMove(move);
    await this.kick(moveId);
    return this.view((await moves.get(moveId)) ?? move, members);
  }

  /** The newest release snapshot whose move committed: the one its receipt check accepted. */
  private async committedRelease(group: string, uuid: string): Promise<SyncSnapshotMeta | null> {
    for (const snap of await this.deps.stores.snapshots.list(group, uuid, 'release')) {
      const move = snap.moveId ? await this.deps.stores.moves.get(snap.moveId) : null;
      if (move?.outcome === 'committed' && move.snapshotId === snap._id) return snap;
    }
    return null;
  }

  /**
   * The `sync_kick` for one presence: the player was seen online on `serverId` at `seenAt`. The
   * key carries that presence, so the force-release call and its gate share one kick.
   */
  private onlineKick(group: string, uuid: string, name: string, serverId: string, seenAt: Date, to: string, members: GroupMember[], createdBy: string): Promise<OpDoc> {
    return this.createOpRaw({
      serverId,
      type: 'sync_kick',
      params: { group, message: SYNC_MESSAGES.staff, to, toLabel: instanceLabel(members, to) },
      target: { uuid, name },
      key: `sync:${group}:${uuid}:online-${serverId}-${seenAt.getTime()}:kick`,
      createdBy,
    });
  }

  async listMoves(group: string, uuid: string, limit: number): Promise<SyncMoveView[]> {
    const members = await this.deps.directory.groupMembers(group);
    const list = await this.deps.stores.moves.listForPlayer(group, uuid, limit);
    const doc = await this.deps.stores.ledger.get(group, uuid);
    return list.map((m) => this.viewOf(m, members, doc));
  }

  /**
   * POST /sync/:group/reseed (spec 6.7), after a restore of `serverId` from a backup. The restore
   * rolled back the stamps and the `away` marks there. Open moves that touch the server close:
   * before their apply went out they abort (`cancelled`, reason `reseed`), after it they go stuck
   * for staff. Docs the server owns get `trustDisk`, so the owner's next join takes its stamp,
   * and a `sync_own` there clears the old marks that would refuse that join. Docs another member
   * owns lose the server from `disowned`, and their disowns run again. World-data records that
   * another instance owns, or that are in transit, get a `sync_lock` there: the restore can bring
   * back a record that left the server. A second call does no harm.
   */
  async reseed(group: string, serverId: string, actor: string): Promise<SyncReseedResult> {
    const { groups, ledger, moves, worldData } = this.deps.stores;
    const g = await groups.get(group);
    if (!g.frozen) throw new SyncConflictError('not_frozen', 'Freeze the group before a reseed.', { mode: g.mode });
    const members = await this.deps.directory.groupMembers(group);
    if (!members.some((m) => m.serverId === serverId)) {
      throw new SyncConflictError('not_member', 'That instance is not part of this pack.', { serverId });
    }

    const at = new Date(this.now());
    const touching = (await moves.listOpen()).filter(
      (m) => m.group === group && m.outcome === null && (m.from === serverId || m.to === serverId || m.disownTo.includes(serverId)),
    );
    const wentOut = new Set<string>();
    for (const m of touching) {
      if (await this.applyWentOut(m)) wentOut.add(m._id);
      await moves.requestCancel(m._id, { by: actor, reason: 'reseed', serverId, at });
    }
    if (touching.length > 0) this.awake = true;
    await Promise.all(touching.map((m) => this.kick(m._id)));
    const movesAborted: string[] = [];
    const movesStuck: string[] = [];
    for (const m of touching) {
      const outcome = (await moves.get(m._id))?.outcome ?? null;
      if (outcome === 'stuck' || (outcome === null && wentOut.has(m._id))) movesStuck.push(m._id);
      else if (outcome !== 'committed') movesAborted.push(m._id);
    }

    const trusted = await ledger.setTrustDisk(group, serverId);
    await ledger.resetDisowned(group, serverId);
    const owners = members.map((m) => m.serverId).filter((s) => s !== serverId);
    const live = g.mode === 'live';
    const disownBatches = live ? await this.reconcileDisowns(group, serverId) : 0;
    const disownsQueued = live && owners.length > 0 ? await ledger.countNeedingDisown(group, serverId, owners) : 0;
    const ownBatches = live ? await this.reconcileOwns(group, serverId) : 0;
    // After the moves above closed: an abort gave its records back to their source, so only
    // records of another owner, or of a stuck move, are still foreign to the server.
    await worldData.markLockPending(group, serverId);
    const lockBatches = live ? await this.reconcileLocks(group, serverId) : 0;

    const result: SyncReseedResult = { group, serverId, movesAborted, movesStuck, trusted, disownsQueued, disownBatches, ownBatches, lockBatches };
    eventBus.emit('biforesting.sync.reseed', { ...result, actor, at });
    logger.warn({ ...result, actor, mode: g.mode }, 'biforesting-sync: reseed after a restore');
    return result;
  }

  /** True when an apply of this move may have reached the target. */
  private async applyWentOut(move: SyncMoveDoc): Promise<boolean> {
    if (move.step !== 'apply') return false;
    if (move.applyUncertain) return true;
    const op = await this.opOf(move.ops.apply);
    return op !== null && !provablyUnrun(op);
  }

  // ── Detector (spec 6.4) ────────────────────────────────────────────────────

  private async detect(at: SyncAt, player: PresencePlayer, stamp: SyncStamp | null, doc: SyncPlayerDoc | null): Promise<void> {
    if (!doc) return;
    const v = Math.max(stamp?.v ?? 0, 0);
    // After a reseed (spec 6.7) the restored owner's stamp is the truth. A lost CAS falls through.
    if (doc.trustDisk && doc.owner === at.serverId && doc.state === 'online') {
      const taken = await this.deps.stores.ledger.acceptDiskStamp(at.group, player.uuid, at.serverId, v);
      if (taken) {
        logger.info(
          { group: at.group, serverId: at.serverId, uuid: player.uuid, before: doc.version, version: v },
          'biforesting-sync: reseed: the owner reported its stamp, the ledger version takes it',
        );
        return;
      }
    }
    if (ownsHere(doc, at.serverId, v)) return;
    // Race guard: read again, and leave alone a player whose apply on this server is done.
    const cur = await this.deps.stores.ledger.get(at.group, player.uuid);
    if (!cur || ownsHere(cur, at.serverId, v)) return;
    // The target of an open move gets a kick only. A disown there could run after the apply and
    // mark the new owner away.
    const target = !!cur.move && cur.move.to === at.serverId && (cur.state === 'moving' || cur.state === 'applying');
    if (target) {
      if (stamp?.m === cur.move!.id) return;
      const move = await this.deps.stores.moves.get(cur.move!.id);
      const apply = move?.ops.apply ? await this.deps.ops.get(move.ops.apply) : null;
      if (apply?.state === 'completed') return;
    }
    await this.kickAndDisown(at, player, cur, !target);
  }

  /** `sync_kick`, plus a one-entry `sync_disown` to the server when `disown`. The ledger stays as it is. */
  private async kickAndDisown(at: SyncAt, player: PresencePlayer, cur: SyncPlayerDoc, disown: boolean): Promise<void> {
    const link = await this.deps.links.instance(at.serverId);
    if (!link || (link.grantedFeatures & PLAYER_SYNC) === 0) {
      logger.warn({ group: at.group, serverId: at.serverId, uuid: cur.uuid }, 'biforesting-sync: detector cannot kick, player_sync is not granted there');
      return;
    }
    const members = await this.deps.directory.groupMembers(at.group);
    const owner = cur.owner ?? cur.move?.to ?? null;
    const toLabel = owner ? instanceLabel(members, owner) : '';
    const message =
      cur.state === 'stuck' ? SYNC_MESSAGES.stuck : cur.owner ? `This character is on ${toLabel}. Join again to go there.` : SYNC_MESSAGES.moving;
    const id = ulid(this.now());
    await this.createOpRaw({
      serverId: at.serverId,
      type: 'sync_kick',
      params: { group: at.group, message, to: owner ?? '', toLabel },
      target: { uuid: cur.uuid, name: player.name || cur.name },
      key: `sync:${at.group}:${cur.uuid}:detect-${id}:kick`,
      createdBy: 'sync:detector',
    });
    if (disown) await this.createDisown(at.group, at.serverId, [{ u: cur.uuid, v: cur.version, to: owner ?? '', toLabel }], id);
    logger.info(
      { group: at.group, serverId: at.serverId, uuid: cur.uuid, owner: cur.owner, state: cur.state, version: cur.version, disown },
      'biforesting-sync: detector kicked a player from an instance that does not own the character',
    );
  }

  // ── Disowns (spec 6.6) ─────────────────────────────────────────────────────

  /**
   * Queue `sync_disown` batches to `member` for every ledger doc of the group that another member
   * owns and whose `disowned` list lacks `member`. Players in a disown op still open to that
   * member are left out. Only a member with a live link and player_sync granted gets batches; the
   * others get theirs at their next register.
   */
  async reconcileDisowns(group: string, member: string): Promise<number> {
    const members = await this.deps.directory.groupMembers(group);
    if (!members.some((m) => m.serverId === member)) return 0;
    const owners = members.map((m) => m.serverId).filter((s) => s !== member);
    if (owners.length === 0) return 0;
    const link = await this.deps.links.instance(member);
    if (!link || (link.grantedFeatures & PLAYER_SYNC) === 0) return 0;
    const inst = await this.deps.directory.instanceOf(member);
    if (!inst) return 0;

    const covered = new Set<string>();
    for (const op of await this.deps.ops.listOpen(inst.instanceKey, 'sync_disown')) {
      for (const e of opEntries(op)) covered.add(e.u);
    }
    let queued = 0;
    let players = 0;
    let afterId: string | undefined;
    for (;;) {
      const page = await this.deps.stores.ledger.listNeedingDisown(group, member, owners, SYNC_DISOWN_MAX_ENTRIES, afterId);
      const entries = page
        .filter((d) => !covered.has(d.uuid) && d.owner)
        .map((d) => ({ u: d.uuid, v: d.version, to: d.owner!, toLabel: instanceLabel(members, d.owner) }));
      if (entries.length > 0) {
        await this.createDisown(group, member, entries, ulid(this.now()));
        queued++;
        players += entries.length;
      }
      if (page.length < SYNC_DISOWN_MAX_ENTRIES) break;
      afterId = page[page.length - 1]!._id;
    }
    if (queued > 0) logger.info({ group, member, batches: queued, players }, 'biforesting-sync: disown batches queued');
    return queued;
  }

  private async createDisown(group: string, serverId: string, entries: Array<{ u: string; v: number; to: string; toLabel: string }>, batchId: string): Promise<OpDoc> {
    return this.createOpRaw({
      serverId,
      type: 'sync_disown',
      params: { group, entries },
      target: null,
      key: `sync:${group}:disown:${serverId}:${batchId}`,
      createdBy: 'sync:disown',
    });
  }

  /** A completed `sync_disown` adds its server to `disowned` on each listed ledger doc. */
  private async recordDisown(op: OpDoc): Promise<void> {
    const group = op.params['group'];
    const key = op.idempotencyKey ?? '';
    if (typeof group !== 'string') return;
    const prefix = `sync:${group}:disown:`;
    if (!key.startsWith(prefix)) return;
    const rest = key.slice(prefix.length);
    const serverId = rest.slice(0, rest.lastIndexOf(':'));
    if (!serverId) return;
    const uuids = opEntries(op).map((e) => e.u);
    await this.deps.stores.ledger.markDisowned(group, uuids, serverId);
  }

  // ── Owns after a reseed (spec 6.7) ─────────────────────────────────────────

  /**
   * Queue `sync_own` batches to `member` for every online ledger doc of the group that it owns
   * and whose `ownPending` names it. Players in a `sync_own` op still open to that member are left
   * out. Only a member with a live link and player_sync granted gets batches; the others get
   * theirs at their next register. A batch that fails is queued again at the next link-up.
   */
  async reconcileOwns(group: string, member: string): Promise<number> {
    const members = await this.deps.directory.groupMembers(group);
    if (!members.some((m) => m.serverId === member)) return 0;
    const link = await this.deps.links.instance(member);
    if (!link || (link.grantedFeatures & PLAYER_SYNC) === 0) return 0;
    const inst = await this.deps.directory.instanceOf(member);
    if (!inst) return 0;

    const covered = new Set<string>();
    for (const op of await this.deps.ops.listOpen(inst.instanceKey, 'sync_own')) {
      for (const e of opEntries(op)) covered.add(e.u);
    }
    let queued = 0;
    let players = 0;
    let afterId: string | undefined;
    for (;;) {
      const page = await this.deps.stores.ledger.listNeedingOwn(group, member, SYNC_OWN_MAX_ENTRIES, afterId);
      const entries = page.filter((d) => !covered.has(d.uuid)).map((d) => ({ u: d.uuid, v: d.version }));
      if (entries.length > 0) {
        await this.createOpRaw({
          serverId: member,
          type: 'sync_own',
          params: { group, entries },
          target: null,
          key: `sync:${group}:own:${member}:${ulid(this.now())}`,
          createdBy: 'sync:own',
        });
        queued++;
        players += entries.length;
      }
      if (page.length < SYNC_OWN_MAX_ENTRIES) break;
      afterId = page[page.length - 1]!._id;
    }
    if (queued > 0) logger.info({ group, member, batches: queued, players }, 'biforesting-sync: own batches queued');
    return queued;
  }

  /** A completed `sync_own` clears `ownPending` on each listed ledger doc. */
  private async recordOwn(op: OpDoc): Promise<void> {
    const group = op.params['group'];
    const key = op.idempotencyKey ?? '';
    if (typeof group !== 'string') return;
    const prefix = `sync:${group}:own:`;
    if (!key.startsWith(prefix)) return;
    const rest = key.slice(prefix.length);
    const serverId = rest.slice(0, rest.lastIndexOf(':'));
    if (!serverId) return;
    await this.deps.stores.ledger.clearOwnPending(group, opEntries(op).map((e) => e.u), serverId);
    const kept = resultData(op)['kept'];
    if (typeof kept === 'number' && kept > 0) {
      logger.warn({ group, serverId, opId: op._id, kept }, 'biforesting-sync: sync_own kept away marks newer than the ledger version');
    }
  }

  // ── World-data locks after a reseed (spec 6.7) ─────────────────────────────

  /**
   * Queue `sync_lock` batches to `member` for every world-data record of the group whose
   * `lockPending` names it. Records in a `sync_lock` op still open to that member are left out,
   * and so are records that `member` owns again. Only a member with a live link and player_sync
   * granted gets batches; the others get theirs at their next register.
   */
  async reconcileLocks(group: string, member: string): Promise<number> {
    const members = await this.deps.directory.groupMembers(group);
    if (!members.some((m) => m.serverId === member)) return 0;
    const link = await this.deps.links.instance(member);
    if (!link || (link.grantedFeatures & PLAYER_SYNC) === 0) return 0;
    const inst = await this.deps.directory.instanceOf(member);
    if (!inst) return 0;

    const covered = new Set<string>();
    for (const op of await this.deps.ops.listOpen(inst.instanceKey, 'sync_lock')) {
      for (const e of lockEntries(op)) covered.add(`${e.h}:${e.key}`);
    }
    const targets = new Map<string, string | null>();
    let queued = 0;
    let records = 0;
    let afterId: string | undefined;
    for (;;) {
      const page = await this.deps.stores.worldData.listNeedingLock(group, member, SYNC_LOCK_MAX_ENTRIES, afterId);
      const entries: Array<{ h: string; key: string; to: string; toLabel: string }> = [];
      for (const d of page) {
        if (covered.has(`${d.handler}:${d.key}`)) continue;
        const to = await this.lockOwner(d, member, targets);
        entries.push({ h: d.handler, key: d.key, to, toLabel: instanceLabel(members, to) });
      }
      if (entries.length > 0) {
        await this.createOpRaw({
          serverId: member,
          type: 'sync_lock',
          params: { group, entries },
          target: null,
          key: `sync:${group}:lock:${member}:${ulid(this.now())}`,
          createdBy: 'sync:lock',
        });
        queued++;
        records += entries.length;
      }
      if (page.length < SYNC_LOCK_MAX_ENTRIES) break;
      afterId = page[page.length - 1]!._id;
    }
    if (queued > 0) logger.info({ group, member, batches: queued, records }, 'biforesting-sync: lock batches queued');
    return queued;
  }

  /**
   * Where the player-facing text of a `sync_lock` points: the owner of an owned record. For a
   * record in transit, the target of its move, else its source. Empty when both are `member`.
   */
  private async lockOwner(doc: SyncWorldDataDoc, member: string, targets: Map<string, string | null>): Promise<string> {
    if (doc.state !== 'in_transit' || !doc.moveId) return doc.owner === member ? '' : doc.owner;
    if (!targets.has(doc.moveId)) targets.set(doc.moveId, (await this.deps.stores.moves.get(doc.moveId))?.to ?? null);
    const to = targets.get(doc.moveId);
    if (to && to !== member) return to;
    return doc.owner === member ? '' : doc.owner;
  }

  /** A completed `sync_lock` takes its member out of `lockPending` on each listed record. */
  private async recordLock(op: OpDoc): Promise<void> {
    const at = batchTarget(op, 'lock');
    if (!at) return;
    this.lockFailures.delete(`${at.group}:${at.serverId}`);
    await this.deps.stores.worldData.clearLockPending(at.group, lockEntries(op), at.serverId);
    const kept = resultData(op)['kept'];
    if (typeof kept === 'number' && kept > 0) {
      logger.info({ ...at, opId: op._id, kept }, 'biforesting-sync: sync_lock kept out locks; the move of each decides');
    }
  }

  /**
   * A `sync_lock` that ended without effect. It is a final op (spec 6.1): a failure with no
   * verdict from the mod, or a cancel, waits for the next register or reg_ack with player_sync
   * of the member. A failure with a verdict goes out again at once, up to
   * {@link MAX_FINAL_ATTEMPTS} times; then it waits too. Its records keep `lockPending` all along.
   */
  private async onLockFailed(op: OpDoc): Promise<void> {
    const at = batchTarget(op, 'lock');
    if (!at) return;
    const why = op.state === 'cancelled' ? 'cancelled' : noVerdict(op);
    if (why) {
      logger.warn({ ...at, opId: op._id, why }, 'biforesting-sync: sync_lock got no verdict; it goes out again at the next register or reg_ack with player_sync');
      return;
    }
    const key = `${at.group}:${at.serverId}`;
    const failures = (this.lockFailures.get(key) ?? 0) + 1;
    this.lockFailures.set(key, failures);
    if (failures >= MAX_FINAL_ATTEMPTS) {
      logger.error({ ...at, opId: op._id, failures, result: describe(op) }, 'biforesting-sync: sync_lock keeps failing; it waits for the next register of the member');
      return;
    }
    logger.warn({ ...at, opId: op._id, failures, result: describe(op) }, 'biforesting-sync: sync_lock failed; it goes out again');
    if ((await this.deps.stores.groups.get(at.group)).mode === 'live') await this.reconcileLocks(at.group, at.serverId);
  }

  // ── Drive loop ─────────────────────────────────────────────────────────────

  private routeOpUpdate = async (op: OpDoc): Promise<void> => {
    if (op.type === 'sync_disown') {
      if (op.state === 'completed') await this.recordDisown(op);
      // A force-release disown carries its move id as the batch id: its gate waits for it.
      const batch = disownBatchOf(op);
      if (batch) await this.kick(batch.split('-')[0]!);
      return;
    }
    if (op.type === 'sync_own') {
      if (op.state === 'completed') await this.recordOwn(op);
      return;
    }
    if (op.type === 'sync_lock') {
      if (op.state === 'completed') await this.recordLock(op);
      else if (op.state === 'failed' || op.state === 'expired' || op.state === 'cancelled') await this.onLockFailed(op);
      return;
    }
    const probed = targetProbeMoveOf(op);
    if (probed) return this.onTargetProbe(probed, op);
    let moveId = typeof op.params['moveId'] === 'string' ? op.params['moveId'] : null;
    if (!moveId && (op.type === 'sync_probe' || op.type === 'sync_kick')) {
      const group = op.params['group'];
      const uuid = op.target?.uuid;
      if (typeof group === 'string' && uuid) moveId = (await this.deps.stores.ledger.get(group, uuid))?.move?.id ?? null;
    }
    if (moveId) await this.kick(moveId);
  };

  private track(p: Promise<void>): Promise<void> {
    const t: Promise<void> = p
      .catch((err) => logger.warn({ err }, 'biforesting-sync: background work failed'))
      .finally(() => this.tasks.delete(t));
    this.tasks.add(t);
    return t;
  }

  /** Drives one move now, or once more after the drive that runs. */
  kick(moveId: string): Promise<void> {
    const current = this.running.get(moveId);
    if (current) {
      this.rerun.add(moveId);
      return current;
    }
    const run = (async (): Promise<void> => {
      try {
        do {
          this.rerun.delete(moveId);
          await this.drive(moveId);
        } while (this.rerun.has(moveId));
      } catch (err) {
        logger.warn({ err, moveId }, 'biforesting-sync: move drive failed; the sweep tries again');
      } finally {
        this.running.delete(moveId);
      }
    })();
    this.running.set(moveId, run);
    return run;
  }

  private later(moveId: string, ms: number): void {
    this.schedule(() => {
      void this.kick(moveId);
    }, ms);
  }

  private async drive(moveId: string): Promise<void> {
    for (let i = 0; i < 16; i++) {
      if (!(await this.step(moveId))) return;
    }
    logger.warn({ moveId }, 'biforesting-sync: 16 transitions in one drive; the sweep goes on');
  }

  /** One transition at most. True when something changed and the move should be read again. */
  private async step(moveId: string): Promise<boolean> {
    const move = await this.deps.stores.moves.get(moveId);
    if (!move || move.step === 'done') return false;
    if (move.step === 'commit') return this.stepCommit(move);
    if (move.step === 'abort') return this.stepAbort(move);
    const claim = await this.claim(move);
    if (claim === 'lost') return false;
    if (claim === 'orphan') return this.orphan(move);
    if (claim === 'stuck') return this.markStuck(move, 'the ledger reads stuck');
    switch (move.step) {
      case 'prepare':
        return this.stepPrepare(move);
      case 'wait_quit':
        return this.stepWaitQuit(move, claim);
      case 'release':
        return this.stepRelease(move);
      case 'disown':
        return this.stepDisown(move, claim);
      case 'apply':
        return this.stepApply(move);
      default:
        return false;
    }
  }

  /** Takes or renews the lease of the ledger doc that names this move. */
  private async claim(move: SyncMoveDoc): Promise<SyncPlayerDoc | 'lost' | 'orphan' | 'stuck'> {
    const now = this.now();
    const doc = await this.deps.stores.ledger.casUpdate(
      { _id: ledgerId(move.group, move.uuid), moveId: move._id, state: ['moving', 'applying'], lease: { holder: this.holder, now: new Date(now) } },
      { $set: { lease: { holder: this.holder, until: new Date(now + this.timing.leaseMs) } } },
    );
    if (doc) {
      this.leased = true;
      return doc;
    }
    const cur = await this.deps.stores.ledger.get(move.group, move.uuid);
    if (!cur || cur.move?.id !== move._id) return 'orphan';
    return cur.state === 'stuck' ? 'stuck' : 'lost';
  }

  // ── Steps ──────────────────────────────────────────────────────────────────

  private async stepPrepare(move: SyncMoveDoc): Promise<boolean> {
    const op = await this.opOf(move.ops.prepare);
    if (!op) {
      if (move.cancel) return this.abort(move, 'cancelled', {});
      const created = await this.createOp(move, move.from!, 'sync_prepare', 'prepare', await this.moveParams(move));
      const probe = await this.sendTargetProbe(move);
      const saved = await this.save(
        move,
        { 'ops.prepare': created._id, ...(probe ? { 'ops.targetProbe': probe } : {}), deadlineAt: new Date(this.now() + this.timing.prepareMs) },
        { step: 'prepare', opId: created._id, status: 'created' },
      );
      if (saved) this.later(move._id, this.timing.prepareMs);
      return saved;
    }
    const c = classifyOp(op);
    if (c.kind === 'applied') {
      if (move.cancel) return this.abort(move, 'cancelled', { opId: op._id });
      // The mod leaves out null keys: only an explicit false says offline.
      const online = resultData(op)['online'] !== false;
      const now = this.now();
      const releaseAt = online ? null : new Date(now + this.timing.releaseDelayMs);
      if (!(await this.ledgerStep(move, 'moving', 'wait_quit'))) return false;
      const saved = await this.save(
        move,
        { step: 'wait_quit', prepareOnline: online, releaseAt, deadlineAt: new Date(now + this.timing.waitQuitMs) },
        { step: 'prepare', opId: op._id, status: 'completed', detail: online ? 'player online' : 'player offline' },
      );
      if (saved) this.later(move._id, releaseAt ? this.timing.releaseDelayMs : this.timing.waitQuitMs);
      if (saved && releaseAt) this.later(move._id, this.timing.waitQuitMs);
      return saved;
    }
    if (c.kind !== 'wait') {
      const code: MoveCode = move.cancel
        ? 'cancelled'
        : c.kind === 'not_applied' ? (c.code === 'blocked' ? 'blocked' : (unreadableCode(c.code) ?? 'error')) : 'error';
      return this.abort(move, code, { opId: op._id, blocked: blockedOf(op), detail: `prepare ${describe(op)}` });
    }
    if (move.cancel) return this.abort(move, 'cancelled', { opId: op._id });
    if (this.now() >= move.deadlineAt.getTime()) {
      return this.abort(move, 'timeout', { opId: op._id, detail: `no prepare result within ${this.timing.prepareMs} ms` });
    }
    return false;
  }

  private async stepWaitQuit(move: SyncMoveDoc, ledger: SyncPlayerDoc): Promise<boolean> {
    if (move.cancel) return this.abort(move, 'cancelled', {});
    const seen = ledger.lastSeen;
    const quit = seen?.serverId === move.from && seen.event === 'quit' && seen.at.getTime() >= move.quitAfter.getTime();
    const now = this.now();
    const due = move.releaseAt !== null && now >= move.releaseAt.getTime();
    if (quit || due) {
      if (!(await this.ledgerStep(move, 'moving', 'release'))) return false;
      return this.save(
        move,
        { step: 'release', deadlineAt: new Date(now + SYNC_OP_DEFAULTS.expiresInMs) },
        { step: 'wait_quit', status: quit ? 'quit seen' : 'offline at prepare' },
      );
    }
    if (now >= move.deadlineAt.getTime()) {
      return this.abort(move, 'player_online', { detail: `the player stayed online on ${move.from} for ${this.timing.waitQuitMs} ms` });
    }
    return false;
  }

  private async stepRelease(move: SyncMoveDoc): Promise<boolean> {
    const op = await this.opOf(move.ops.release);
    if (!op) {
      if (move.cancel) return this.abort(move, 'cancelled', {});
      const n = move.attempts.release;
      const created = await this.createOp(move, move.from!, 'sync_release', n === 0 ? 'release' : `release:${n}`, await this.moveParams(move));
      return this.save(
        move,
        { 'ops.release': created._id, 'attempts.release': n + 1, probe: null },
        { step: 'release', opId: created._id, status: 'created', ...(n > 0 ? { detail: `attempt ${n + 1}` } : {}) },
      );
    }
    const c = classifyOp(op);
    if (c.kind === 'applied') return this.onReleased(move, op);
    if (c.kind === 'not_applied') {
      if (c.code === 'blocked') return this.abort(move, 'blocked', { opId: op._id, blocked: blockedOf(op), detail: `release ${describe(op)}` });
      if (move.cancel) return this.abort(move, 'cancelled', { opId: op._id });
      if (c.code === 'player_online') {
        if (move.waitQuitRetried) return this.abort(move, 'player_online', { opId: op._id, detail: 'the source still reports the player online' });
        return this.backToWaitQuit(move, op);
      }
      if (RELEASE_RETRY_CODES.has(c.code) && move.attempts.release < MAX_RELEASE_ATTEMPTS) return this.retry(move, 'release', op, c.code);
      return this.abort(move, unreadableCode(c.code) ?? 'error', { opId: op._id, detail: `release ${describe(op)}` });
    }
    if (c.kind === 'unknown' || this.staleAcked(op)) return this.resolveRelease(move, op);
    if (move.cancel && isPreAck(op)) return (await this.deps.ops.cancel(op._id, 'sync-runner')) !== null;
    return false;
  }

  /** Release outcome unknown: probe the source, then retry the release or abort. */
  private async resolveRelease(move: SyncMoveDoc, op: OpDoc): Promise<boolean> {
    const p = await this.probeFor(move, 'release', move.from!, op);
    if (p === 'pending') return false;
    if (p === 'progress') return true;
    if (p === 'exhausted') return this.markStuck(move, 'the release outcome is unknown and the source answers no probe');
    const released = p.applied || move.released;
    if (move.cancel) return this.abort(move, 'cancelled', { opId: op._id, released });
    if (move.attempts.release < MAX_RELEASE_ATTEMPTS) {
      return this.retry(move, 'release', op, p.applied ? 'stamped, no receipt' : 'not stamped', { released });
    }
    return this.abort(move, 'error', { opId: op._id, released, detail: `release outcome unknown after ${move.attempts.release} attempts` });
  }

  /** A completed release: check the receipt, lock world data, then apply. */
  private async onReleased(move: SyncMoveDoc, op: OpDoc): Promise<boolean> {
    const { snapshots, worldData } = this.deps.stores;
    const data = resultData(op);
    const sha = typeof data['sha256'] === 'string' ? data['sha256'].toLowerCase() : null;
    // The receipt is the snapshot of exactly this release: group, uuid, v, source, move and sha256.
    const snapId = syncSnapshotId(move.group, move.uuid, move.vTo, 'release', move.from!, { moveId: move._id, sha256: sha });
    const snap = sha ? await snapshots.getMeta(snapId) : null;
    if (!snap || snap.sha256 !== sha || snap.moveId !== move._id) {
      // Spec 3.4: a release result with no stored snapshot counts as not_applied.
      logger.warn({ moveId: move._id, snapshotId: snapId, sha256: sha, stored: snap?.sha256 ?? null }, 'biforesting-sync: release result has no stored snapshot');
      if (move.cancel) return this.abort(move, 'cancelled', { opId: op._id, released: true });
      if (move.attempts.release < MAX_RELEASE_ATTEMPTS) return this.retry(move, 'release', op, 'no snapshot receipt', { released: true });
      return this.abort(move, 'error', { opId: op._id, released: true, detail: 'the release snapshot never arrived' });
    }
    if (move.cancel) return this.abort(move, 'cancelled', { opId: op._id, released: true });

    const records = worldDataOf(data['worldData'], snap.header.worldData);
    for (const wd of records) {
      const holder = await worldData.toInTransit(move.group, wd.h, wd.key, move.from!, move._id, move.uuid);
      if (holder) {
        const where = holder.state === 'in_transit' ? `in transit for move ${holder.moveId ?? '?'}` : `owned by ${holder.owner}`;
        return this.abort(move, 'error', { opId: op._id, released: true, worldData: records, detail: `world data ${wd.h}:${wd.key} is ${where}` });
      }
    }
    const now = new Date(this.now());
    const ledgerOk = await this.ledgerCas(move, ['moving', 'applying'], {
      state: 'applying',
      owner: null,
      version: move.vTo,
      'move.step': 'apply',
      'move.updatedAt': now,
    });
    if (!ledgerOk) return false;
    return this.save(
      move,
      {
        step: 'apply',
        released: true,
        snapshotId: snapId,
        sha256: sha,
        fp: snap.fp,
        worldData: records,
        probe: null,
        deadlineAt: new Date(now.getTime() + SYNC_OP_DEFAULTS.expiresInMs),
      },
      { step: 'release', opId: op._id, status: 'completed', detail: snapId },
    );
  }

  /**
   * Force-release gate (step `disown`): every instance of `disownTo` gets a `sync_kick` and a
   * one-entry `sync_disown`, and the apply waits until each disown completed. A dead member of a
   * stuck ledger keeps its disown queued and blocks nothing. Presence that shows the player online
   * on any member also needs a completed kick there first.
   */
  private async stepDisown(move: SyncMoveDoc, ledger: SyncPlayerDoc): Promise<boolean> {
    if (move.cancel) {
      for (const g of move.gate) {
        const op = await this.opOf(g.disown);
        if (op && isPreAck(op)) await this.deps.ops.cancel(op._id, 'sync-runner');
      }
      return this.abort(move, 'cancelled', {});
    }
    const members = await this.deps.directory.groupMembers(move.group);
    const toLabel = instanceLabel(members, move.to);
    const stuck = move.before?.state === 'stuck';
    const gate: SyncGateEntry[] = move.gate.map((g) => ({ ...g }));
    const notes: string[] = [];
    for (const g of gate) {
      if (g.done) continue;
      if (!g.kick) {
        g.kick = (await this.createOp(move, g.serverId, 'sync_kick', `kick-${g.serverId}`, { group: move.group, message: SYNC_MESSAGES.staff, to: move.to, toLabel }))._id;
        notes.push(`kick ${g.serverId}`);
      }
      const op = await this.opOf(g.disown);
      if (!op) {
        const batch = g.attempts === 0 ? move._id : `${move._id}-${g.attempts}`;
        g.disown = (await this.createDisown(move.group, g.serverId, [{ u: move.uuid, v: move.vTo, to: move.to, toLabel }], batch))._id;
        g.attempts++;
        notes.push(`disown ${g.serverId}`);
        continue;
      }
      const s = await this.finalState(op, g.serverId, g.attempts - g.uncounted);
      if (s.kind === 'done') {
        g.done = true;
        notes.push(`${g.serverId} disowned`);
      } else if (s.kind === 'exhausted') {
        return this.abort({ ...move, gate }, 'error', { opId: op._id, detail: `sync_disown on ${g.serverId} failed: ${describe(op)}` });
      } else if (s.kind === 'retry') {
        g.disown = null;
        if (s.uncounted) g.uncounted++;
        notes.push(`${g.serverId} retry: ${s.why}`);
      } else if (stuck && !(await this.deps.links.instance(g.serverId))) {
        g.done = true;
        notes.push(`${g.serverId} has no link and the ledger is stuck: its disown stays queued`);
        if (op.state !== 'pending') logger.warn({ moveId: move._id, serverId: g.serverId, opId: op._id, state: op.state }, 'biforesting-sync: force-release goes on; this disown is not queued, a later reconcile must cover it');
      }
    }
    if (notes.length > 0) return this.save(move, { gate }, { step: 'disown', status: 'gate', detail: notes.join('; ') });
    const open = gate.filter((g) => !g.done);
    if (open.length > 0) {
      for (const g of open) {
        const op = await this.opOf(g.disown);
        const why = op ? noVerdict(op) : null;
        if (op && why) return this.park(move, 'disown', op, g.serverId, why);
      }
      return false;
    }
    if (!(await this.presenceClear(move, ledger, members))) return false;
    if (!(await this.ledgerStep(move, 'applying', 'apply'))) return false;
    return this.save(
      move,
      { step: 'apply', deadlineAt: new Date(this.now() + SYNC_OP_DEFAULTS.expiresInMs) },
      { step: 'disown', status: 'completed', detail: gate.map((g) => g.serverId).join(',') || 'nobody' },
    );
  }

  /**
   * True when presence shows the player online on no member, or a kick there completed after that
   * presence. It sends that kick. A dead member of a stuck ledger never blocks.
   */
  private async presenceClear(move: SyncMoveDoc, ledger: SyncPlayerDoc, members: GroupMember[]): Promise<boolean> {
    const seen = ledger.lastSeen;
    if (!seen || seen.event === 'quit' || !members.some((m) => m.serverId === seen.serverId)) return true;
    const link = await this.deps.links.instance(seen.serverId);
    if (!link && move.before?.state === 'stuck') return true;
    if (!link || (link.grantedFeatures & PLAYER_SYNC) === 0) return false;
    const kick = await this.onlineKick(move.group, move.uuid, move.name, seen.serverId, seen.at, move.to, members, `sync-runner (${move.actor})`);
    return kick.state === 'completed';
  }

  private applyParams(move: SyncMoveDoc): Record<string, unknown> {
    return { group: move.group, moveId: move._id, v: move.vTo, sha256: move.sha256 ?? '', fp: move.fp ?? '', snapshotId: move.snapshotId ?? '' };
  }

  private async stepApply(move: SyncMoveDoc): Promise<boolean> {
    const op = await this.opOf(move.ops.apply);
    if (move.cancel?.reason === 'reseed') return this.reseedApply(move, op);
    if (move.cancel?.reason === 'staff' && move.applyUncertain) return this.cancelUncertainApply(move);
    // An attempt with an unknown outcome went out, so a mode change lets the move finish (spec 6.6).
    const cancelling = move.cancel !== null && !move.applyUncertain;
    if (!op) {
      if (cancelling) return this.abort(move, 'cancelled', {});
      const n = move.attempts.apply;
      const created = await this.createOp(move, move.to, 'sync_apply', n === 0 ? 'apply' : `apply:${n}`, this.applyParams(move));
      return this.save(
        move,
        { 'ops.apply': created._id, 'attempts.apply': n + 1, probe: null },
        { step: 'apply', opId: created._id, status: 'created', ...(n > 0 ? { detail: `attempt ${n + 1}` } : {}) },
      );
    }
    const c = classifyOp(op);
    if (c.kind === 'applied') return this.onApplied(move, op, 'apply completed', false);
    // A staff cancel probes after dispatch. A mode change lets a dispatched apply finish (spec 6.6).
    const cancel = cancelling && (move.cancel?.reason === 'staff' || provablyUnrun(op));
    if (c.kind === 'not_applied') {
      // Spec 6.1: after an attempt with an unknown outcome, the target may hold part of an apply.
      if (move.applyUncertain) return this.markStuck(move, `apply ${describe(op)}, after an earlier apply attempt with an unknown outcome`);
      if (cancel) return this.abort(move, 'cancelled', { opId: op._id, detail: `apply ${describe(op)}` });
      if (c.code === 'guard_busy' && move.attempts.apply < MAX_APPLY_ATTEMPTS) return this.retry(move, 'apply', op, c.code);
      const code: MoveCode =
        c.code === 'fingerprint_mismatch' ? 'fingerprint_mismatch' : c.code === 'player_online' ? 'player_online' : (unreadableCode(c.code) ?? 'error');
      return this.abort(move, code, { opId: op._id, detail: `apply ${describe(op)}` });
    }
    if (c.kind === 'unknown' || this.staleAcked(op) || (cancel && op.state === 'acked')) {
      const p = await this.probeFor(move, 'apply', move.to, op);
      if (p === 'pending') return false;
      if (p === 'progress') return true;
      if (p === 'exhausted') return this.markStuck(move, 'the apply outcome is unknown and the target answers no probe');
      if (p.applied) {
        const why = p.away ? `probe found the stamp, and away of ${p.away.m} is still set there` : 'probe found the stamp';
        return this.onApplied(move, op, `${why}; apply again at commit`, true);
      }
      // Not applied yet, and the op may still run on the target: its result decides.
      if (c.kind === 'wait') return false;
      if (cancel) return this.abort(move, 'cancelled', { opId: op._id, detail: 'the probe found no stamp' });
      // This attempt's outcome stays unknown: it may have imported handler data before it failed.
      if (move.attempts.apply < MAX_APPLY_ATTEMPTS) return this.retry(move, 'apply', op, 'the probe found no stamp', { applyUncertain: true });
      return this.markStuck(move, 'the apply outcome is unknown, the probe found no stamp, and the retry is used up');
    }
    if (cancel && isPreAck(op)) return (await this.deps.ops.cancel(op._id, 'sync-runner')) !== null;
    return false;
  }

  /**
   * A staff cancel after an apply attempt with an unknown outcome (spec 6.3). Apply ops of the
   * move before their ack are cancelled first. Then a probe of the target, sent after the cancel
   * request and after the last change of any apply op, decides: a stamp of this move commits the
   * move. No stamp, and no apply op of the move can still run: abort. Otherwise the running op
   * decides.
   */
  private async cancelUncertainApply(move: SyncMoveDoc): Promise<boolean> {
    const ops: OpDoc[] = [];
    for (const id of await this.applyOpIds(move)) {
      let op = await this.deps.ops.get(id);
      if (op && isPreAck(op)) op = (await this.deps.ops.cancel(op._id, 'sync-runner')) ?? (await this.deps.ops.get(id));
      if (op) ops.push(op);
    }
    const completed = ops.find((o) => o.state === 'completed');
    if (completed) return this.onApplied(move, completed, 'apply completed', false);
    const last = ops.reduce<OpDoc | null>((a, o) => (a === null || o.updatedAt.getTime() > a.updatedAt.getTime() ? o : a), null);
    if (!last) return this.markStuck(move, `${cancelDetail(move.cancel)}; an apply attempt had an unknown outcome and its op is gone`);
    const p = await this.probeFor(move, 'apply', move.to, last, move.cancel?.at);
    if (p === 'pending') return false;
    if (p === 'progress') return true;
    if (p === 'exhausted') return this.markStuck(move, `${cancelDetail(move.cancel)}; the apply outcome is unknown and the target answers no probe`);
    if (p.applied) {
      const why = p.away ? `probe found the stamp, and away of ${p.away.m} is still set there` : 'probe found the stamp';
      return this.onApplied(move, last, `${cancelDetail(move.cancel)}: ${why}; apply again at commit`, true);
    }
    if (ops.some((o) => classifyOp(o).kind === 'wait')) return false;
    return this.abort(move, 'cancelled', { opId: last._id, detail: `${cancelDetail(move.cancel)}; the probe found no stamp, and no apply op can still run` });
  }

  /**
   * A reseed closes a move at step apply (spec 6.7). An apply that never left Yggdrasil is
   * cancelled and the move aborts. An apply that went out may have changed the target, so the
   * move goes stuck and staff decide, also when that apply completed.
   */
  private async reseedApply(move: SyncMoveDoc, op: OpDoc | null): Promise<boolean> {
    let cur = op;
    if (cur && isPreAck(cur)) cur = (await this.deps.ops.cancel(cur._id, 'sync-runner')) ?? (await this.deps.ops.get(cur._id));
    const wentOut = move.applyUncertain || (cur !== null && (isPreAck(cur) || !provablyUnrun(cur)));
    if (wentOut) return this.markStuck(move, `${cancelDetail(move.cancel)}; the apply went out to ${move.to}, so staff must decide`);
    return this.abort(move, 'cancelled', op ? { opId: op._id } : {});
  }

  /**
   * The apply took effect: world data to the target, then the outcome. The ledger write follows.
   * `reapply`: a probe proved it, so step commit sends the apply once more (see `needsReapply`).
   */
  private async onApplied(move: SyncMoveDoc, op: OpDoc, via: string, reapply: boolean): Promise<boolean> {
    const { worldData } = this.deps.stores;
    if (move.kind === 'force_release') {
      for (const wd of move.worldData) await worldData.forceOwned(move.group, wd.h, wd.key, move.to, move.uuid);
    } else {
      await worldData.settle(move.group, move._id, move.to);
    }
    return this.save(
      move,
      { step: 'commit', outcome: 'committed', code: null, endedAt: new Date(this.now()), ledgerDone: false, probe: null, needsReapply: reapply },
      { step: 'apply', opId: op._id, status: 'completed', detail: via },
    );
  }

  /**
   * Ledger `online(to, vTo)` at once. Then the re-apply on the target when a probe proved the
   * apply, then `sync_commit` to the source. The ledger never waits for either op.
   */
  private async stepCommit(move: SyncMoveDoc): Promise<boolean> {
    if (!move.ledgerDone) {
      const away = await this.awayAfterCommit(move);
      const disowned = away.length > 0 ? { $addToSet: { disowned: { $each: away } } } : {};
      if (!(await this.ledgerFinal(move, 'applying', { state: 'online', owner: move.to, version: move.vTo, move: null, lease: null }, disowned))) return false;
      logger.info({ group: move.group, uuid: move.uuid, moveId: move._id, owner: move.to, version: move.vTo }, 'biforesting-sync: move committed');
      return this.save(move, { ledgerDone: true }, { step: 'commit', status: 'ledger', detail: `online(${move.to}, ${move.vTo})` });
    }
    if (move.needsReapply) return this.stepReapply(move);
    if (move.kind === 'force_release' || !move.from) return this.save(move, { step: 'done' }, { step: 'commit', status: 'done' });
    const op = await this.opOf(move.ops.commit);
    if (!op) {
      const n = move.attempts.commit;
      const created = await this.createOp(move, move.from, 'sync_commit', n === 0 ? 'commit' : `commit:${n}`, {
        group: move.group,
        moveId: move._id,
        v: move.vTo,
      });
      return this.save(move, { 'ops.commit': created._id, 'attempts.commit': n + 1 }, { step: 'commit', opId: created._id, status: 'created' });
    }
    const s = await this.finalState(op, move.from, move.attempts.commit - move.uncounted.commit);
    switch (s.kind) {
      case 'wait':
        return false;
      case 'done':
        return this.save(move, { step: 'done' }, { step: 'commit', opId: op._id, status: 'completed' });
      case 'parked':
        return this.park(move, 'commit', op, move.from, s.why);
      case 'retry':
        return this.retry(move, 'commit', op, s.why, s.uncounted ? { 'uncounted.commit': move.uncounted.commit + 1 } : {});
      case 'exhausted':
        logger.warn({ moveId: move._id, from: move.from }, 'biforesting-sync: sync_commit failed for good; the source keeps its out locks');
        return this.save(
          move,
          { step: 'done', error: { code: 'commit_failed', message: `sync_commit on ${move.from} failed: ${describe(op)}` } },
          { step: 'commit', opId: op._id, status: op.state, detail: 'gave up' },
        );
    }
  }

  /**
   * The members that hold an `away` mark for this player once the move commits, for the ledger's
   * `disowned` list (spec 6.6). A move: the source, whose release set the mark. A force-release:
   * each gate member whose `sync_disown` completed. Without them, the next reconcile sends the
   * source a disown that overwrites the move id of its mark.
   */
  private async awayAfterCommit(move: SyncMoveDoc): Promise<string[]> {
    if (move.kind !== 'force_release') return move.from && move.from !== move.to ? [move.from] : [];
    const out: string[] = [];
    for (const g of move.gate) {
      if (g.serverId !== move.to && (await this.opOf(g.disown))?.state === 'completed') out.push(g.serverId);
    }
    return out;
  }

  /**
   * Step commit after a probe proved the apply: the same `sync_apply` once more. Its `already`
   * path on the target clears an `away` or `moving` mark that a crash between the `.dat` write and
   * the state save left behind. A `player_online` answer also ends it: the login passed there.
   */
  private async stepReapply(move: SyncMoveDoc): Promise<boolean> {
    const op = await this.opOf(move.ops.reapply);
    if (!op) {
      const n = move.attempts.reapply;
      const created = await this.createOp(move, move.to, 'sync_apply', n === 0 ? 'reapply' : `reapply:${n}`, this.applyParams(move));
      return this.save(
        move,
        { 'ops.reapply': created._id, 'attempts.reapply': n + 1 },
        { step: 'commit', opId: created._id, status: 'reapply', ...(n > 0 ? { detail: `attempt ${n + 1}` } : {}) },
      );
    }
    const c = classifyOp(op);
    if (c.kind === 'not_applied' && c.code === 'player_online') {
      return this.save(move, { needsReapply: false }, { step: 'commit', opId: op._id, status: 'reapplied', detail: 'the player is online on the target' });
    }
    const s = await this.finalState(op, move.to, move.attempts.reapply - move.uncounted.reapply);
    switch (s.kind) {
      case 'wait':
        return false;
      case 'done':
        return this.save(move, { needsReapply: false }, { step: 'commit', opId: op._id, status: 'reapplied' });
      case 'parked':
        return this.park(move, 'reapply', op, move.to, s.why);
      case 'retry':
        return this.retry(move, 'reapply', op, s.why, s.uncounted ? { 'uncounted.reapply': move.uncounted.reapply + 1 } : {});
      case 'exhausted':
        logger.error(
          { group: move.group, uuid: move.uuid, moveId: move._id, to: move.to, opId: op._id, result: describe(op) },
          'biforesting-sync: the re-apply failed for good; the new owner may still refuse the player (away). Staff must check the target',
        );
        return this.save(
          move,
          { needsReapply: false, error: { code: 'reapply_failed', message: `sync_apply again on ${move.to} failed: ${describe(op)}` } },
          { step: 'commit', opId: op._id, status: op.state, detail: 'reapply gave up' },
        );
    }
  }

  /**
   * Ledger back to the source at once, then `sync_abort` to the source when a prepare or a
   * release may have run there. The abort op waits until no op of the move can still run on the
   * source, so a late prepare can never arm the move mark after the abort cleared it.
   */
  private async stepAbort(move: SyncMoveDoc): Promise<boolean> {
    if (!move.ledgerDone) {
      const set =
        move.kind === 'force_release' && move.before
          ? { state: move.before.state, owner: move.before.owner, version: move.before.version, move: move.before.move, lease: null }
          : { state: 'online', owner: move.from, version: move.released ? move.vTo : move.vFrom, move: null, lease: null };
      if (!(await this.ledgerFinal(move, ['moving', 'applying'], set))) return false;
      logger.info({ group: move.group, uuid: move.uuid, moveId: move._id, code: move.code, owner: set.owner, version: set.version }, 'biforesting-sync: move aborted');
      return this.save(move, { ledgerDone: true }, { step: 'abort', status: 'ledger', detail: `${String(set.state)}(${set.owner ?? '-'}, ${set.version})` });
    }
    if (move.kind === 'force_release' || !move.from) return this.save(move, { step: 'done' }, { step: 'abort', status: 'done' });

    const sourceOps: OpDoc[] = [];
    for (const id of this.sourceOpIds(move)) {
      let op = await this.deps.ops.get(id);
      if (op && isPreAck(op)) op = (await this.deps.ops.cancel(op._id, 'sync-runner')) ?? (await this.deps.ops.get(id));
      if (!op) continue;
      if (isPreAck(op) || op.state === 'acked') return false;
      sourceOps.push(op);
    }
    if (sourceOps.every((op) => provablyUnrun(op))) {
      return this.save(move, { step: 'done' }, { step: 'abort', status: 'skipped', detail: 'nothing ran on the source' });
    }
    const op = await this.opOf(move.ops.abort);
    if (!op) {
      const n = move.attempts.abort;
      const created = await this.createOp(move, move.from, 'sync_abort', n === 0 ? 'abort' : `abort:${n}`, { group: move.group, moveId: move._id });
      return this.save(move, { 'ops.abort': created._id, 'attempts.abort': n + 1 }, { step: 'abort', opId: created._id, status: 'created' });
    }
    const s = await this.finalState(op, move.from, move.attempts.abort - move.uncounted.abort);
    switch (s.kind) {
      case 'wait':
        return false;
      case 'done':
        return this.save(move, { step: 'done' }, { step: 'abort', opId: op._id, status: 'completed' });
      case 'parked':
        return this.park(move, 'abort', op, move.from, s.why);
      case 'retry':
        return this.retry(move, 'abort', op, s.why, s.uncounted ? { 'uncounted.abort': move.uncounted.abort + 1 } : {});
      case 'exhausted':
        logger.warn({ moveId: move._id, from: move.from }, 'biforesting-sync: sync_abort failed for good; the source may refuse the player login');
        return this.save(
          move,
          { step: 'done', error: { code: 'abort_failed', message: `sync_abort on ${move.from} failed: ${describe(op)}` } },
          { step: 'abort', opId: op._id, status: op.state, detail: 'gave up' },
        );
    }
  }

  // ── Final ops ──────────────────────────────────────────────────────────────

  /**
   * Where a final op stands (abort, commit, re-apply, a force-release disown). A failure with no
   * verdict from the mod ({@link noVerdict}) does not count: the op runs again once the instance
   * is back with player_sync, or after its next link-up or reg_ack. `counted`: attempts so far
   * that count.
   */
  private async finalState(op: OpDoc, on: string, counted: number): Promise<FinalState> {
    const c = classifyOp(op);
    if (c.kind === 'wait') return { kind: 'wait' };
    if (c.kind === 'applied') return { kind: 'done' };
    const why = noVerdict(op);
    if (why) return (await this.mayRunAgain(op, on, why)) ? { kind: 'retry', uncounted: true, why: `${why}, not counted` } : { kind: 'parked', why };
    return counted < MAX_FINAL_ATTEMPTS ? { kind: 'retry', uncounted: false, why: describe(op) } : { kind: 'exhausted' };
  }

  /**
   * True when a final op that got no verdict may go out again now: a link-up or a player_sync
   * grant of its instance came after it was parked. Without the bit or a link, also true once the
   * instance is back with player_sync. An `inert` mod needs the link-up or grant, else every
   * retry gets the same answer.
   */
  private async mayRunAgain(op: OpDoc, on: string, why: NoVerdict): Promise<boolean> {
    const epoch = this.linkEpoch.get(on) ?? 0;
    const parked = this.parkedAt.get(op._id);
    if (parked === undefined) this.parkedAt.set(op._id, epoch);
    else if (epoch > parked) {
      this.parkedAt.delete(op._id);
      return true;
    }
    if (why === 'inert') return false;
    const link = await this.deps.links.instance(on);
    if (!link || (link.grantedFeatures & PLAYER_SYNC) === 0) return false;
    this.parkedAt.delete(op._id);
    return true;
  }

  /** A final op with no verdict waits for its instance. The move records that once; the drive stops. */
  private async park(move: SyncMoveDoc, step: string, op: OpDoc, on: string, why: NoVerdict): Promise<boolean> {
    const last = move.steps[move.steps.length - 1];
    if (last?.opId === op._id && last.status === 'parked') return false;
    logger.warn({ moveId: move._id, step, opId: op._id, on, why }, 'biforesting-sync: op parked until a link-up or a player_sync grant of the instance');
    await this.save(move, {}, { step, opId: op._id, status: 'parked', detail: `${why}: waits for a link-up or a player_sync grant on ${on}` });
    return false;
  }

  // ── Transitions ────────────────────────────────────────────────────────────

  /**
   * End the move without a commit. World data in transit for it goes back to the source. The
   * ledger write follows at step abort. A force-release whose gate disowned an old copy goes
   * stuck instead: the old owner would refuse the player after a rollback.
   */
  private async abort(
    move: SyncMoveDoc,
    code: MoveCode,
    opts: { opId?: string; blocked?: SyncBlockedEntry[]; detail?: string; released?: boolean; worldData?: Array<{ h: string; key: string }> },
  ): Promise<boolean> {
    const detail = opts.detail ?? (code === 'cancelled' ? cancelDetail(move.cancel) : code);
    if (move.kind === 'force_release' && (await this.gateRan(move))) {
      return this.markStuck(move, `${detail}; an old copy may be disowned already, so the ledger cannot go back`);
    }
    if (move.kind === 'move' && move.from) await this.deps.stores.worldData.settle(move.group, move._id, move.from);
    const outcome: MoveOutcome = code === 'cancelled' ? 'cancelled' : 'aborted';
    const reason = move.cancel?.reason;
    const errorCode = code === 'cancelled' && (reason === 'mode_off' || reason === 'reseed') ? reason : code;
    return this.save(
      move,
      {
        step: 'abort',
        outcome,
        code,
        released: opts.released ?? move.released,
        blocked: opts.blocked && opts.blocked.length > 0 ? opts.blocked : move.blocked,
        error: { code: errorCode, message: detail },
        endedAt: new Date(this.now()),
        ledgerDone: false,
        probe: null,
        ...(opts.worldData ? { worldData: opts.worldData } : {}),
      },
      { step: move.step, ...(opts.opId ? { opId: opts.opId } : {}), status: 'abort', code, detail },
    );
  }

  /** True when a force-release disown may have run on an old copy. */
  private async gateRan(move: SyncMoveDoc): Promise<boolean> {
    for (const g of move.gate) {
      if (g.done) return true;
      const op = await this.opOf(g.disown);
      if (op && classifyOp(op).kind !== 'not_applied') return true;
    }
    return false;
  }

  /** Nothing safe is left to do: the ledger goes `stuck` and keeps the move, staff decide. */
  private async markStuck(move: SyncMoveDoc, detail: string): Promise<boolean> {
    const ok = await this.ledgerFinal(move, ['moving', 'applying', 'stuck'], { state: 'stuck', lease: null, 'move.step': move.step });
    if (!ok) return false;
    logger.error({ group: move.group, uuid: move.uuid, moveId: move._id, step: move.step, detail }, 'biforesting-sync: move stuck, staff must decide');
    return this.save(
      move,
      { step: 'done', outcome: 'stuck', code: 'error', endedAt: new Date(this.now()), ledgerDone: true, error: { code: 'stuck', message: detail } },
      { step: move.step, status: 'stuck', detail },
    );
  }

  /** The ledger no longer names this move. Close the move doc; abort on the source if needed. */
  private async orphan(move: SyncMoveDoc): Promise<boolean> {
    logger.warn({ moveId: move._id, group: move.group, uuid: move.uuid, step: move.step }, 'biforesting-sync: the ledger no longer names this move');
    return this.save(
      move,
      {
        step: 'abort',
        outcome: 'aborted',
        code: 'error',
        error: { code: 'orphan', message: 'the ledger no longer names this move' },
        endedAt: new Date(this.now()),
        ledgerDone: true,
        probe: null,
      },
      { step: move.step, status: 'orphan' },
    );
  }

  /** A ledger doc names a move with no move doc (a crash at start): put the player back. */
  private async dropMissingMove(doc: SyncPlayerDoc): Promise<void> {
    const move = doc.move!;
    const set =
      doc.state === 'moving'
        ? { state: 'online', owner: move.from, move: null, lease: null }
        : { state: 'stuck', lease: null };
    const ok = await this.deps.stores.ledger.casUpdate(
      { _id: doc._id, moveId: move.id, state: doc.state, lease: { holder: this.holder, now: new Date(this.now()) } },
      { $set: set } as UpdateFilter<SyncPlayerDoc>,
    );
    if (ok) logger.warn({ ledgerId: doc._id, moveId: move.id, state: set.state }, 'biforesting-sync: ledger named a move with no move doc; put back');
  }

  private async backToWaitQuit(move: SyncMoveDoc, op: OpDoc): Promise<boolean> {
    const now = this.now();
    if (!(await this.ledgerStep(move, 'moving', 'wait_quit'))) return false;
    const saved = await this.save(
      move,
      {
        step: 'wait_quit',
        'ops.release': null,
        waitQuitRetried: true,
        quitAfter: new Date(now),
        releaseAt: new Date(now + this.timing.releaseDelayMs),
        deadlineAt: new Date(now + this.timing.waitQuitMs),
      },
      { step: 'release', opId: op._id, status: 'failed', code: 'player_online', detail: 'back to wait_quit once' },
    );
    if (saved) {
      this.later(move._id, this.timing.releaseDelayMs);
      this.later(move._id, this.timing.waitQuitMs);
    }
    return saved;
  }

  /** Forget the op of a step, so the next pass creates a fresh one with the next key suffix. */
  private retry(move: SyncMoveDoc, step: 'release' | 'apply' | 'reapply' | 'commit' | 'abort', op: OpDoc, why: string, extra: StepSet = {}): Promise<boolean> {
    return this.save(move, { [`ops.${step}`]: null, probe: null, ...extra }, { step, opId: op._id, status: op.state, detail: `retry: ${why}` });
  }

  /**
   * The probe answer for the current step op. A probe counts only when it was created after the
   * step op last changed, and, with `notBefore` (runner clock), not before that time. Returns
   * `pending` while it runs, `progress` after creating one, and `exhausted` when the probe budget
   * is used up.
   */
  private async probeFor(move: SyncMoveDoc, purpose: 'release' | 'apply', on: string, stepOp: OpDoc, notBefore?: Date): Promise<ProbeAnswer> {
    const pr = move.probe;
    if (pr && pr.for === purpose && pr.after === stepOp._id && (!notBefore || pr.at.getTime() >= notBefore.getTime())) {
      const pop = await this.opOf(pr.opId);
      if (pop && pop.createdAt.getTime() >= stepOp.updatedAt.getTime()) {
        const pc = classifyOp(pop);
        if (pc.kind === 'wait') return 'pending';
        if (pc.kind === 'applied') {
          const data = resultData(pop);
          const stamp = toSyncStamp(data['stamp']);
          return { applied: stamp !== null && stamp.g === move.group && stamp.v === move.vTo && stamp.m === move._id, away: awayOf(data['away']) };
        }
      }
    }
    if (move.attempts.probe >= MAX_PROBES) return 'exhausted';
    const n = move.attempts.probe;
    const created = await this.createOp(move, on, 'sync_probe', `probe:${n}`, { group: move.group });
    const saved = await this.save(
      move,
      { probe: { opId: created._id, on, for: purpose, after: stepOp._id, at: new Date(this.now()) }, 'attempts.probe': n + 1 },
      { step: move.step, opId: created._id, status: 'probe', detail: `${purpose} op ${stepOp._id} is ${stepOp.state}` },
      { 'ops.probe': created._id },
    );
    return saved ? 'progress' : 'pending';
  }

  // ── Target probe (spec 6.1) ────────────────────────────────────────────────

  /**
   * `sync_probe` to the target at move start, beside the prepare. It only tells whether the target
   * holds an independent character of the player. It never blocks or aborts the move, so a
   * failure here only logs.
   */
  private async sendTargetProbe(move: SyncMoveDoc): Promise<string | null> {
    try {
      return (await this.createOp(move, move.to, 'sync_probe', TARGET_PROBE, { group: move.group }))._id;
    } catch (err) {
      logger.warn({ err, moveId: move._id, to: move.to }, 'biforesting-sync: target probe not sent; targetHasCharacter stays null');
      return null;
    }
  }

  /**
   * A completed target probe sets `targetHasCharacter` and wakes the long polls of the move. Only
   * an independent character counts: a `.dat` with no stamp, or with the stamp of another group.
   * A `.dat` stamped for this group is the player's own copy that an earlier move released or a
   * disown marked away (a round trip A to B to A), so it counts as false.
   */
  private async onTargetProbe(moveId: string, op: OpDoc): Promise<void> {
    if (op.state !== 'completed') return;
    const data = resultData(op);
    const exists = data['datExists'];
    if (typeof exists !== 'boolean') return;
    const move = await this.deps.stores.moves.get(moveId);
    if (!move) return;
    const stamp = exists ? toSyncStamp(data['stamp']) : null;
    const ownCopy = stamp !== null && stamp.g === move.group;
    const has = exists && !ownCopy;
    if (move.targetHasCharacter === has) return;
    const detail = !exists
      ? 'the target holds no .dat of this player'
      : ownCopy
        ? `the target holds a .dat stamped for ${move.group} (v ${stamp.v}): a copy of this group, not an independent character`
        : 'the target holds an independent character of this player';
    const record = { step: move.step, at: new Date(this.now()), opId: op._id, status: 'target_probe', detail };
    if (await this.deps.stores.moves.setTargetHasCharacter(moveId, op._id, has, record)) this.changes.emit(moveId);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private newMove(f: {
    _id: string;
    group: string;
    uuid: string;
    name: string;
    kind: SyncMoveDoc['kind'];
    from: string | null;
    to: string;
    vFrom: number;
    vTo: number;
    actor: string;
    reason: string | null;
    step: MoveStep;
    now: Date;
    deadlineAt: Date;
  }): SyncMoveDoc {
    return {
      _id: f._id,
      group: f.group,
      uuid: f.uuid,
      name: f.name,
      kind: f.kind,
      from: f.from,
      to: f.to,
      vFrom: f.vFrom,
      vTo: f.vTo,
      actor: f.actor,
      reason: f.reason,
      step: f.step,
      outcome: null,
      code: null,
      ops: { probe: [] },
      attempts: { release: 0, apply: 0, reapply: 0, commit: 0, abort: 0, probe: 0 },
      uncounted: { reapply: 0, commit: 0, abort: 0 },
      snapshotId: null,
      sha256: null,
      fp: null,
      blocked: [],
      worldData: [],
      error: null,
      steps: [{ step: f.step, at: f.now, status: 'started', detail: `by ${f.actor}` }],
      released: false,
      applyUncertain: false,
      needsReapply: false,
      ledgerDone: false,
      prepareOnline: null,
      targetHasCharacter: null,
      quitAfter: f.now,
      releaseAt: null,
      waitQuitRetried: false,
      probe: null,
      cancel: null,
      before: null,
      disownTo: [],
      gate: [],
      startedAt: f.now,
      updatedAt: f.now,
      endedAt: null,
      deadlineAt: f.deadlineAt,
    };
  }

  /** Writes the move doc while it is still at its step. Emits on a step or outcome change. */
  private async save(move: SyncMoveDoc, set: StepSet, record?: Omit<MoveStepRecord, 'at'>, push: StepSet = {}): Promise<boolean> {
    const update: Record<string, unknown> = { $set: set };
    const pushes: StepSet = { ...push };
    if (record) pushes['steps'] = { ...record, at: new Date(this.now()) };
    if (Object.keys(pushes).length > 0) update['$push'] = pushes;
    const next = await this.deps.stores.moves.update(move._id, move.step, update as UpdateFilter<SyncMoveDoc>);
    if (!next) return false;
    if (next.step !== move.step || next.outcome !== move.outcome) this.emitMove(next);
    return true;
  }

  /** CAS of the ledger doc that names this move, under our lease. `extra`: update operators besides `$set`. */
  private ledgerCas(move: SyncMoveDoc, state: SyncPlayerState | SyncPlayerState[], set: StepSet, extra: UpdateFilter<SyncPlayerDoc> = {}): Promise<SyncPlayerDoc | null> {
    return this.deps.stores.ledger.casUpdate(
      { _id: ledgerId(move.group, move.uuid), moveId: move._id, state, lease: { holder: this.holder, now: new Date(this.now()) } },
      { ...extra, $set: set } as UpdateFilter<SyncPlayerDoc>,
    );
  }

  private async ledgerStep(move: SyncMoveDoc, state: SyncPlayerState, step: MoveStep): Promise<boolean> {
    return (await this.ledgerCas(move, state, { 'move.step': step, 'move.updatedAt': new Date(this.now()) })) !== null;
  }

  /**
   * The final ledger write of a move. True when it landed now, or earlier (the ledger no longer
   * names the move). False when another lease holder has the doc.
   */
  private async ledgerFinal(move: SyncMoveDoc, state: SyncPlayerState | SyncPlayerState[], set: StepSet, extra: UpdateFilter<SyncPlayerDoc> = {}): Promise<boolean> {
    if (await this.ledgerCas(move, state, set, extra)) return true;
    const cur = await this.deps.stores.ledger.get(move.group, move.uuid);
    if (!cur || cur.move?.id !== move._id) return true;
    return cur.state === 'stuck' && set['state'] === 'stuck';
  }

  private async moveParams(move: SyncMoveDoc): Promise<Record<string, unknown>> {
    const members = await this.deps.directory.groupMembers(move.group);
    return { group: move.group, moveId: move._id, v: move.vTo, to: move.to, toLabel: instanceLabel(members, move.to) };
  }

  /**
   * Every op id an apply attempt of this move used on the target, plus any open apply op of the
   * move there that the move doc missed (a crash between its create and the save). The re-apply
   * at commit is not one.
   */
  private async applyOpIds(move: SyncMoveDoc): Promise<string[]> {
    const ids = new Set<string>();
    for (const r of move.steps) if (r.step === 'apply' && r.opId && r.status === 'created') ids.add(r.opId);
    if (move.ops.apply) ids.add(move.ops.apply);
    const inst = await this.deps.directory.instanceOf(move.to);
    if (inst) {
      const prefix = `sync:${move.group}:${move.uuid}:${move._id}:apply`;
      for (const op of await this.deps.ops.listOpen(inst.instanceKey, 'sync_apply')) {
        if (op.idempotencyKey?.startsWith(prefix)) ids.add(op._id);
      }
    }
    return [...ids];
  }

  /** Every op id a prepare or a release of this move used on the source. */
  private sourceOpIds(move: SyncMoveDoc): string[] {
    const ids = new Set<string>();
    if (move.ops.prepare) ids.add(move.ops.prepare);
    if (move.ops.release) ids.add(move.ops.release);
    for (const r of move.steps) if ((r.step === 'prepare' || r.step === 'release') && r.opId && r.status === 'created') ids.add(r.opId);
    return [...ids];
  }

  private staleAcked(op: OpDoc): boolean {
    return op.state === 'acked' && op.ackedAt !== null && this.now() - op.ackedAt.getTime() > op.execTimeoutMs;
  }

  private async opOf(id: string | null | undefined): Promise<OpDoc | null> {
    return id ? this.deps.ops.get(id) : null;
  }

  private createOp(move: SyncMoveDoc, serverId: string, type: string, step: string, params: Record<string, unknown>): Promise<OpDoc> {
    return this.createOpRaw({
      serverId,
      type,
      params,
      target: { uuid: move.uuid, name: move.name },
      key: `sync:${move.group}:${move.uuid}:${move._id}:${step}`,
      createdBy: `sync-runner (${move.actor})`,
    });
  }

  /** Creates and dispatches one sync op. A replayed key returns the stored op and sends nothing new. */
  private async createOpRaw(input: { serverId: string; type: string; params: Record<string, unknown>; target: OpTarget | null; key: string; createdBy: string }): Promise<OpDoc> {
    const inst = await this.deps.directory.instanceOf(input.serverId);
    if (!inst) throw new Error(`player sync: server ${input.serverId} resolves to no instance`);
    const params = catalogEntry(input.type)!.params.parse(input.params) as Record<string, unknown>;
    const { op, replayed } = await this.deps.ops.create({
      instanceKey: inst.instanceKey,
      serverTag: inst.tag,
      type: input.type,
      params,
      target: input.target,
      idempotencyKey: input.key,
      ...SYNC_OP_DEFAULTS,
      createdBy: input.createdBy,
    });
    if (!replayed) await this.deps.dispatch.onOpCreated(op);
    return op;
  }

  private emitMove(move: SyncMoveDoc): void {
    eventBus.emit('biforesting.sync.move', {
      moveId: move._id,
      group: move.group,
      uuid: move.uuid,
      name: move.name,
      kind: move.kind,
      from: move.from,
      to: move.to,
      vFrom: move.vFrom,
      vTo: move.vTo,
      step: move.step,
      outcome: move.outcome,
      code: move.code,
      at: new Date(this.now()),
    });
    this.changes.emit(move._id);
  }

  private nextChange(moveId: string, ms: number, signal?: AbortSignal): { promise: Promise<void>; cancel: () => void } {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    let timer: NodeJS.Timeout | null = null;
    const finish = (): void => {
      if (timer) clearTimeout(timer);
      this.changes.off(moveId, finish);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    this.changes.on(moveId, finish);
    signal?.addEventListener('abort', finish);
    return { promise, cancel: finish };
  }

  private async findMove(group: string, uuid: string, moveId: string): Promise<SyncMoveDoc> {
    const move = await this.deps.stores.moves.get(moveId);
    if (!move || move.group !== group || move.uuid !== uuid.toLowerCase()) throw new NotFoundError('Sync move', moveId);
    return move;
  }

  private async view(move: SyncMoveDoc, members?: GroupMember[]): Promise<SyncMoveView> {
    const ms = members ?? (await this.deps.directory.groupMembers(move.group));
    return this.viewOf(move, ms, await this.deps.stores.ledger.get(move.group, move.uuid));
  }

  private viewOf(move: SyncMoveDoc, members: GroupMember[], doc: SyncPlayerDoc | null): SyncMoveView {
    // The outcome lands on the move doc one step before the ledger write. A long poll wakes on
    // the outcome, so until that write the view shows the owner and version it will set.
    const settled = move.outcome !== null && !move.ledgerDone ? settledLedger(move) : null;
    return {
      id: move._id,
      group: move.group,
      uuid: move.uuid,
      name: move.name,
      kind: move.kind,
      from: move.from,
      to: move.to,
      vFrom: move.vFrom,
      vTo: move.vTo,
      step: move.step,
      outcome: move.outcome,
      code: move.code,
      owner: settled ? settled.owner : (doc?.owner ?? null),
      version: settled ? settled.version : (doc?.version ?? null),
      message: moveMessage(move, members),
      ...(move.blocked.length > 0 ? { blocked: move.blocked } : {}),
      targetHasCharacter: move.targetHasCharacter,
      error: move.error,
      actor: move.actor,
      reason: move.reason,
      startedAt: move.startedAt,
      endedAt: move.endedAt,
    };
  }
}

/** The error message of a cancelled move. */
function cancelDetail(cancel: SyncMoveDoc['cancel']): string {
  if (cancel?.reason === 'reseed') return `reseed of ${cancel.serverId ?? '?'} by ${cancel.by}`;
  return `cancelled by ${cancel?.by ?? 'staff'}`;
}

/** The owner and version that steps commit and abort write to the ledger for a move with an outcome. */
function settledLedger(move: SyncMoveDoc): { owner: string | null; version: number } {
  if (move.outcome === 'committed') return { owner: move.to, version: move.vTo };
  if (move.kind === 'force_release' && move.before) return { owner: move.before.owner, version: move.before.version };
  return { owner: move.from, version: move.released ? move.vTo : move.vFrom };
}

/** The owner with a matching stamp is fine, also while its own move is still before the release. */
function ownsHere(doc: SyncPlayerDoc, serverId: string, v: number): boolean {
  return doc.owner === serverId && doc.version === v && (doc.state === 'online' || doc.state === 'moving');
}
