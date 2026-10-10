import { EventEmitter } from 'node:events';
import { logger } from '../../core/logger/index.js';
import { AppError, NotFoundError } from '../../shared/errors/index.js';
import { catalogEntry } from '../../domains/biforesting/ops-catalog.js';
import { FEATURE_BITS } from './policy-store.js';
import { ulid } from './ulid.js';
import { QUEST_LOCK_PREFIX, questLockHeld, type SyncLedgerStore, type SyncPlayerDoc } from './sync-ledger-store.js';
import { questMergeId, type QuestMergeStart, type SyncQuestMergeDoc, type SyncQuestMergesStore } from './sync-quest-merges-store.js';
import { instanceLabel, SYNC_MESSAGES, SyncConflictError, type SyncRunnerDirectory } from './sync-runner.js';
import type { SyncGroupsStore } from './sync-groups-store.js';
import type { SyncSnapshotStore } from './sync-snapshot-store.js';
import type { SyncInstanceLink, SyncLinkPort } from './sync-service.js';
import type { OpsStore } from './ops-store.js';
import type { GroupMember } from './server-resolver.js';
import type { OpDoc, OpState, OpTarget } from './types.js';

/**
 * Quest progress REST on the Yggdrasil side (valhallamc-work
 * evol-multi-instance-2026-10/phase6/DESIGN.md 4 and 7, contract-notes-bifrost.md): the `/quests`
 * menu status and actions, the party candidates of the other instances, and the party merge.
 *
 * Every call sends ops to the instances and waits for their results, so the REST answer carries
 * the mod's answer. Each call has a budget that ends before Bifrost stops waiting. An action and a
 * party merge need the ledger doc `online` on the instance the op goes to. They hold the quest
 * lock (the ledger lease, holder `quests:<id>`) while their ops run, so no move or force-release
 * starts in that time, and an action never starts during a move. When an op that writes may still
 * run after the answer (no result in time), the lock stays until it lapses. Each op expires at the
 * end of the budget and the mod refuses an op past its `expiresAt`, so the lock outlasts any late run.
 */

const PLAYER_SYNC = FEATURE_BITS['player_sync']!;
const OPS = FEATURE_BITS['ops']!;

/** Op settings of every quest op. Each op expires at the end of its call budget. */
export const QUEST_OP_DEFAULTS = {
  dispatchTimeoutMs: 5_000,
  execTimeoutMs: 20_000,
  maxAttempts: 1,
} as const;

/** Call budgets. Bifrost waits 10 s (status), 20 s (action), 15 s (candidates) and 30 s (merge). */
export interface SyncQuestsTiming {
  statusMs: number;
  actionMs: number;
  candidatesMs: number;
  mergeMs: number;
  /** The wait reads the op doc again this often, besides the op update hook. */
  pollMs: number;
}

export const DEFAULT_QUESTS_TIMING: SyncQuestsTiming = { statusMs: 8_000, actionMs: 15_000, candidatesMs: 12_000, mergeMs: 25_000, pollMs: 1_000 };

/** The least time left for a new op. With less, the call answers `timeout` and creates none. */
const MIN_OP_MS = 500;
/** Added to the quest lock after the call budget and the exec time of a late op. */
const LOCK_SLACK_MS = 5_000;

/** After these op states nothing more happens for a REST call. A `waiting_player` op gets cancelled. */
const ENDED: ReadonlySet<OpState> = new Set(['completed', 'failed', 'cancelled', 'expired', 'waiting_player']);

/**
 * The `message` lines of the answers. Bifrost shows its own text per code and never shows
 * `message`. The mod's own text never goes out: it can hold Java exception text.
 */
export const QUEST_MESSAGES = {
  paused: 'Quest options are paused right now.',
  moving: 'Your character is moving between instances. Try again when it has arrived.',
  notOnline: 'Your character is on no instance right now.',
  notOwner: 'Your character is on another instance now.',
  frozen: 'Party merges are paused right now.',
  playerOffline: 'Join the server first, then try again.',
  sameInstance: 'That party is on the instance you play on. Pick a party on another instance.',
  sameTeam: 'That is your own party.',
  notInParty: 'Join or create a party on this instance first.',
  alreadyMerged: 'You already merged that party into your party.',
  mergeBusy: 'This party merge is still running. Try again in a minute.',
  badExport: 'The other instance sent no usable party book.',
  refused: 'The instance refused this quest call.',
  callFailed: 'The call to this instance failed.',
} as const;

/** A mod code goes out only in this shape. Any other value goes out as `failed`. */
const MOD_CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function modCode(v: unknown): string {
  return typeof v === 'string' && MOD_CODE_RE.test(v) ? v : 'failed';
}

/**
 * A quest op that did not complete. `unsettled` is true when the op may still run on the
 * instance after this answer: it went out and no result came.
 */
export class QuestOpError extends AppError {
  constructor(
    statusCode: number,
    code: string,
    message: string,
    readonly unsettled: boolean,
    details?: Record<string, unknown>,
  ) {
    super(message, statusCode, code, details);
  }
}

export interface SyncQuestsDeps {
  stores: { groups: SyncGroupsStore; ledger: SyncLedgerStore; merges: SyncQuestMergesStore; snapshots: Pick<SyncSnapshotStore, 'findPartyExport'> };
  ops: Pick<OpsStore, 'create' | 'get' | 'cancel'>;
  dispatch: { onOpCreated(op: OpDoc): Promise<void> };
  directory: SyncRunnerDirectory;
  links: SyncLinkPort;
  now?: () => number;
  timing?: Partial<SyncQuestsTiming>;
}

export interface QuestActionInput {
  action: 'pref' | 'fresh' | 'leave' | 'undo';
  value?: 'merge' | 'separate' | undefined;
  backupId?: string | undefined;
}

export interface QuestCandidateInstance {
  serverId: string;
  instanceNumber: number | null;
  label: string;
  /** `offline`: no live link with player_sync. `error`: the op failed or had no result in time. */
  status: 'ok' | 'offline' | 'error';
  code?: string;
  message?: string;
}

export interface QuestMergeView {
  id: string;
  sourceServerId: string;
  sourceTeamId: string;
  targetServerId: string;
  targetTeamId: string;
  state: SyncQuestMergeDoc['state'];
  backupId: string | null;
  code: string | null;
  attempts: number;
  startedAt: Date;
  endedAt: Date | null;
}

interface OwnerAt {
  doc: SyncPlayerDoc;
  owner: string;
  members: GroupMember[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A completed write result as the caller gets it. The mod's `message` stays out. A refusal
 * (`ok: false`) gets a checked code and a fixed line.
 */
function writeResult(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  delete out['message'];
  if (out['ok'] !== false) return out;
  return { ...out, code: modCode(out['code']), message: QUEST_MESSAGES.refused };
}

function mergeView(doc: SyncQuestMergeDoc): QuestMergeView {
  return {
    id: doc._id,
    sourceServerId: doc.sourceServerId,
    sourceTeamId: doc.sourceTeamId,
    targetServerId: doc.targetServerId,
    targetTeamId: doc.targetTeamId,
    state: doc.state,
    backupId: doc.backupId,
    code: doc.code,
    attempts: doc.attempts,
    startedAt: doc.startedAt,
    endedAt: doc.endedAt,
  };
}

/** The 409 for a ledger doc that is not `online` with an owner. */
function notOnline(doc: Pick<SyncPlayerDoc, 'state' | 'move' | 'owner'>): SyncConflictError {
  const details = { state: doc.state, moveId: doc.move?.id ?? null };
  if (doc.state === 'stuck') return new SyncConflictError('stuck', SYNC_MESSAGES.stuck, details);
  if (doc.state === 'moving' || doc.state === 'applying') return new SyncConflictError(doc.state, QUEST_MESSAGES.moving, details);
  return new SyncConflictError('not_online', QUEST_MESSAGES.notOnline, details);
}

export class SyncQuests {
  private readonly now: () => number;
  private readonly timing: SyncQuestsTiming;
  /** Op ids whose op reached an end state, from the op update hook. */
  private readonly ended = new EventEmitter();

  constructor(private readonly deps: SyncQuestsDeps) {
    this.now = deps.now ?? Date.now;
    this.timing = { ...DEFAULT_QUESTS_TIMING, ...(deps.timing ?? {}) };
    this.ended.setMaxListeners(0);
  }

  /** The op dispatcher update hook. It wakes the REST call that waits for this op. */
  onOpUpdate(op: OpDoc): Promise<void> {
    if (op.type.startsWith('quests_') && ENDED.has(op.state)) this.ended.emit(op._id);
    return Promise.resolve();
  }

  // ── REST ───────────────────────────────────────────────────────────────────

  /** GET .../quests: `quests_status` on the owner. The answer is the mod result plus `owner`. */
  async status(group: string, rawUuid: string, actor: string): Promise<Record<string, unknown>> {
    const deadline = this.now() + this.timing.statusMs;
    const uuid = rawUuid.toLowerCase();
    const at = await this.ownerOf(group, uuid);
    await this.requireLink(at.owner, at.members, 'instance_offline');
    const { data } = await this.call(at.owner, 'quests_status', { group, uuid }, { uuid, name: at.doc.name }, actor, at.members, deadline);
    return { ...data, owner: at.owner, ownerLabel: instanceLabel(at.members, at.owner) };
  }

  /** POST .../quests/action: `quests_action` on the owner under the quest lock. */
  async action(group: string, rawUuid: string, input: QuestActionInput, actor: string): Promise<Record<string, unknown>> {
    const deadline = this.now() + this.timing.actionMs;
    const uuid = rawUuid.toLowerCase();
    const at = await this.ownerOf(group, uuid);
    await this.requireLink(at.owner, at.members, 'instance_offline');
    const params: Record<string, unknown> = { group, uuid, action: input.action };
    if (input.value !== undefined) params['value'] = input.value;
    if (input.backupId !== undefined) params['backupId'] = input.backupId;
    const holder = await this.lock(group, uuid, at.owner, deadline);
    let release = true;
    try {
      const { data: raw } = await this.call(at.owner, 'quests_action', params, { uuid, name: at.doc.name }, actor, at.members, deadline);
      const data = writeResult(raw);
      logger.info(
        { group, uuid, owner: at.owner, action: input.action, ok: data['ok'], code: data['code'], backupId: data['backupId'], modMessage: raw['message'], actor },
        'biforesting-sync: quest action answered',
      );
      return { ...data, owner: at.owner, ownerLabel: instanceLabel(at.members, at.owner) };
    } catch (err) {
      if (err instanceof QuestOpError && err.unsettled) release = false;
      throw err;
    } finally {
      if (release) await this.unlock(group, uuid, holder);
    }
  }

  /**
   * GET .../quests/party-candidates: `quests_party_candidates` on every other member at once. A
   * member without a live link, or one whose op fails, goes into `offline` (and `instances` with
   * its status); the other members still answer (`partial: true`). Each party carries the
   * `serverId` that holds it and the `done` merges out of it.
   */
  async partyCandidates(group: string, rawUuid: string, actor: string): Promise<Record<string, unknown>> {
    const deadline = this.now() + this.timing.candidatesMs;
    const uuid = rawUuid.toLowerCase();
    const at = await this.ownerOf(group, uuid);
    const others = at.members.filter((m) => m.serverId !== at.owner);
    const answers = await Promise.all(
      others.map(async (m): Promise<{ instance: QuestCandidateInstance; parties: Array<Record<string, unknown>> }> => {
        const base = { serverId: m.serverId, instanceNumber: m.instanceNumber, label: instanceLabel(at.members, m.serverId) };
        const link = await this.deps.links.instance(m.serverId);
        if (!link || (link.grantedFeatures & PLAYER_SYNC) === 0 || (link.grantedFeatures & OPS) === 0) {
          return { instance: { ...base, status: 'offline' }, parties: [] };
        }
        try {
          const { data } = await this.call(m.serverId, 'quests_party_candidates', { group, uuid }, { uuid, name: at.doc.name }, actor, at.members, deadline);
          const list = Array.isArray(data['parties']) ? data['parties'].filter(isRecord).filter((p) => typeof p['teamId'] === 'string') : [];
          return { instance: { ...base, status: 'ok' }, parties: list.map((p) => ({ ...p, teamId: String(p['teamId']).toLowerCase(), ...base })) };
        } catch (err) {
          const code = err instanceof AppError ? err.code : 'error';
          const message = err instanceof Error ? err.message : String(err);
          logger.warn({ group, uuid, serverId: m.serverId, code, message }, 'biforesting-sync: quest party candidates of one member failed');
          const shown = err instanceof AppError ? err.message : QUEST_MESSAGES.callFailed;
          return { instance: { ...base, status: 'error', code, message: shown }, parties: [] };
        }
      }),
    );
    const parties = answers.flatMap((a) => a.parties);
    const done = await this.deps.stores.merges.listDoneFrom(
      group,
      parties.map((p) => ({ serverId: String(p['serverId']), teamId: String(p['teamId']) })),
    );
    return {
      group,
      uuid,
      owner: at.owner,
      ownerLabel: instanceLabel(at.members, at.owner),
      partial: answers.some((a) => a.instance.status !== 'ok'),
      offline: answers.filter((a) => a.instance.status !== 'ok').map((a) => a.instance.serverId),
      instances: answers.map((a) => a.instance),
      parties: parties.map((p) => ({
        ...p,
        mergedInto: done
          .filter((d) => d.sourceServerId === p['serverId'] && d.sourceTeamId === p['teamId'])
          .map((d) => ({ targetServerId: d.targetServerId, targetTeamId: d.targetTeamId, at: d.endedAt })),
      })),
    };
  }

  /**
   * POST .../quests/party-merge: under the quest lock, `quests_status` on the owner names the
   * target party, the merge doc reserves the (source, target) pair, `quests_export_party` on
   * `fromServer` reads the source book, and `quests_import_party` on the owner merges it. One
   * `done` merge per pair; a later call answers 409 `already_merged`.
   *
   * The record never rides in op JSON. The export sends it up as a `party_export` syncsnap before
   * its result, and the result names it by sha256. The session handles its messages in order, so
   * the snapshot is stored when the result arrives. The import op names the snapshot, and the
   * dispatcher attaches its gz as the op blob.
   */
  async partyMerge(group: string, rawUuid: string, input: { fromServer: string; teamId: string }, actor: string): Promise<Record<string, unknown>> {
    const deadline = this.now() + this.timing.mergeMs;
    const uuid = rawUuid.toLowerCase();
    const sourceTeamId = input.teamId.toLowerCase();
    const { fromServer } = input;
    const at = await this.ownerOf(group, uuid);
    const { owner, members, doc } = at;
    if ((await this.deps.stores.groups.get(group)).frozen) throw new SyncConflictError('frozen', QUEST_MESSAGES.frozen, {});
    if (fromServer === owner) throw new SyncConflictError('same_instance', QUEST_MESSAGES.sameInstance, { serverId: fromServer });
    if (!members.some((m) => m.serverId === fromServer)) {
      throw new SyncConflictError('not_member', 'That instance is not part of this pack.', { serverId: fromServer });
    }
    const target = await this.requireLink(owner, members, 'instance_offline');
    const source = await this.requireLink(fromServer, members, 'source_offline');
    if (!target.fp || target.fp !== source.fp) {
      throw new SyncConflictError('fingerprint_mismatch', SYNC_MESSAGES.fingerprint, { from: source.fp, to: target.fp });
    }

    const holder = await this.lock(group, uuid, owner, deadline);
    let release = true;
    let importing = false;
    try {
      const st = await this.call(owner, 'quests_status', { group, uuid }, { uuid, name: doc.name }, actor, members, deadline);
      const book = isRecord(st.data['book']) ? st.data['book'] : null;
      if (!book || book['kind'] !== 'party' || typeof book['teamId'] !== 'string') {
        throw new SyncConflictError('not_in_party', QUEST_MESSAGES.notInParty, { book: book ?? null });
      }
      const targetTeamId = book['teamId'].toLowerCase();
      if (targetTeamId === sourceTeamId) throw new SyncConflictError('same_team', QUEST_MESSAGES.sameTeam, { teamId: sourceTeamId });
      const merge = await this.reserve({ group, uuid, name: doc.name, sourceServerId: fromServer, sourceTeamId, targetServerId: owner, targetTeamId, runId: holder, actor });

      try {
        const exp = await this.call(fromServer, 'quests_export_party', { group, teamId: sourceTeamId }, null, actor, members, deadline, {
          offlineCode: 'source_offline',
          onCreated: (op) => this.deps.stores.merges.update(merge._id, holder, { exportOpId: op._id }).then(() => undefined),
        });
        const sha256 = typeof exp.data['sha256'] === 'string' ? exp.data['sha256'].toLowerCase() : '';
        if (!/^[0-9a-f]{64}$/.test(sha256)) {
          throw new QuestOpError(502, 'bad_export', QUEST_MESSAGES.badExport, false, { reason: 'the export result has no sha256' });
        }
        const snap = await this.deps.stores.snapshots.findPartyExport(group, fromServer, sourceTeamId, sha256);
        if (!snap) {
          throw new QuestOpError(502, 'bad_export', QUEST_MESSAGES.badExport, false, { reason: 'the party_export snapshot was not stored', sha256 });
        }
        importing = true;
        const imp = await this.call(
          owner,
          'quests_import_party',
          { group, uuid, sha256, snapshotId: snap._id, sourceServerId: fromServer, sourceTeamId },
          { uuid, name: doc.name },
          actor,
          members,
          deadline,
          {
            onCreated: (op) => this.deps.stores.merges.update(merge._id, holder, { importOpId: op._id }).then(() => undefined),
          },
        );
        const data = writeResult(imp.data);
        const ok = data['ok'] !== false;
        const backupId = typeof data['backupId'] === 'string' ? data['backupId'] : null;
        const code = ok ? null : String(data['code']);
        const final = await this.deps.stores.merges.update(
          merge._id,
          holder,
          ok ? { state: 'done', backupId, endedAt: new Date(this.now()) } : { state: 'failed', code: code ?? 'failed', endedAt: new Date(this.now()) },
        );
        logger.info(
          { group, uuid, mergeId: merge._id, ok, code, backupId, modMessage: imp.data['message'], snapshotId: snap._id, gzLen: snap.gzLen, actor },
          'biforesting-sync: quest party merge answered',
        );
        return { ...data, owner, ownerLabel: instanceLabel(members, owner), merge: mergeView(final ?? merge) };
      } catch (err) {
        // An import that may still run keeps the doc `running`. The next call settles it from the op.
        if (!(importing && err instanceof QuestOpError && err.unsettled)) {
          const code = err instanceof AppError ? err.code : 'error';
          const error = err instanceof Error ? err.message : String(err);
          await this.deps.stores.merges.update(merge._id, holder, { state: 'failed', code, error, endedAt: new Date(this.now()) });
        }
        throw err;
      }
    } catch (err) {
      // Only the import writes. A status or an export that may still run changes nothing.
      if (importing && err instanceof QuestOpError && err.unsettled) release = false;
      throw err;
    } finally {
      if (release) await this.unlock(group, uuid, holder);
    }
  }

  // ── Guards ─────────────────────────────────────────────────────────────────

  /** The ledger doc in mode live, `online` with an owner that is a member of the group. */
  private async ownerOf(group: string, uuid: string): Promise<OwnerAt> {
    const g = await this.deps.stores.groups.get(group);
    if (g.mode !== 'live') throw new SyncConflictError('mode_off', QUEST_MESSAGES.paused, { mode: g.mode });
    const doc = await this.deps.stores.ledger.get(group, uuid);
    if (!doc) throw new NotFoundError('Sync player', `${group}:${uuid}`);
    if (doc.state !== 'online' || doc.move || !doc.owner) throw notOnline(doc);
    const members = await this.deps.directory.groupMembers(group);
    if (!members.some((m) => m.serverId === doc.owner)) {
      throw new SyncConflictError('not_member', 'That instance is not part of this pack.', { serverId: doc.owner });
    }
    return { doc, owner: doc.owner, members };
  }

  /** A live link with player_sync and ops. Else a 409 with `offlineCode`, or `feature_missing`. */
  private async requireLink(serverId: string, members: GroupMember[], offlineCode: 'instance_offline' | 'source_offline'): Promise<SyncInstanceLink> {
    const label = instanceLabel(members, serverId);
    const link = await this.deps.links.instance(serverId);
    if (!link) throw new SyncConflictError(offlineCode, `${label} is not reachable right now. Try again later.`, { serverId });
    if ((link.grantedFeatures & PLAYER_SYNC) === 0 || (link.grantedFeatures & OPS) === 0) {
      throw new SyncConflictError('feature_missing', `Quest options are not open on ${label} yet.`, { serverId });
    }
    return link;
  }

  /**
   * Takes the quest lock until the call `deadline`, plus the exec time of an op that starts at the
   * deadline. 409 `busy` while another quest call holds it. Another refusal when a move took the
   * doc or the owner changed since the check.
   */
  private async lock(group: string, uuid: string, owner: string, deadline: number): Promise<string> {
    const { ledger } = this.deps.stores;
    const holder = `${QUEST_LOCK_PREFIX}${ulid()}`;
    const now = this.now();
    const until = new Date(deadline + QUEST_OP_DEFAULTS.execTimeoutMs + LOCK_SLACK_MS);
    if (await ledger.takeQuestLock(group, uuid, owner, holder, new Date(now), until)) return holder;
    const cur = await ledger.get(group, uuid);
    if (cur && questLockHeld(cur, now)) throw new SyncConflictError('busy', SYNC_MESSAGES.questsBusy, {});
    if (!cur || cur.state !== 'online' || cur.move || !cur.owner) throw notOnline(cur ?? { state: 'online', move: null, owner: null });
    throw new SyncConflictError('not_owner', QUEST_MESSAGES.notOwner, { owner: cur.owner });
  }

  private async unlock(group: string, uuid: string, holder: string): Promise<void> {
    try {
      await this.deps.stores.ledger.releaseLease(group, uuid, holder);
    } catch (err) {
      logger.warn({ err, group, uuid, holder }, 'biforesting-sync: quest lock release failed; it lapses on its own');
    }
  }

  /**
   * Reserves the (source, target) pair for this attempt. 409 `already_merged` for a `done` pair,
   * 409 `busy` while another attempt may still run. A `failed` pair starts a new attempt.
   */
  private async reserve(input: QuestMergeStart): Promise<SyncQuestMergeDoc> {
    const { merges } = this.deps.stores;
    const id = questMergeId(input.group, input.sourceServerId, input.sourceTeamId, input.targetServerId, input.targetTeamId);
    for (let i = 0; i < 3; i++) {
      const inserted = await merges.insertRunning(input);
      if (inserted) return inserted;
      let cur = await merges.get(id);
      if (!cur) continue;
      if (cur.state === 'running') cur = await this.settleRunning(cur);
      if (cur.state === 'done') {
        throw new SyncConflictError('already_merged', QUEST_MESSAGES.alreadyMerged, { mergeId: id, at: cur.endedAt, backupId: cur.backupId });
      }
      if (cur.state === 'running') throw new SyncConflictError('busy', QUEST_MESSAGES.mergeBusy, { mergeId: id });
      const restarted = await merges.restart(id, { uuid: input.uuid, name: input.name, runId: input.runId, actor: input.actor });
      if (restarted) return restarted;
    }
    throw new SyncConflictError('busy', QUEST_MESSAGES.mergeBusy, { mergeId: id });
  }

  /**
   * A `running` merge doc of another attempt. Its import op decides: completed means `done`
   * (unless the mod answered `ok: false`), an ended op without that means `failed`, an open op
   * keeps it `running`. With no import op, the doc is `failed` once its attempt no longer holds
   * the quest lock of its player.
   */
  private async settleRunning(cur: SyncQuestMergeDoc): Promise<SyncQuestMergeDoc> {
    const { merges, ledger } = this.deps.stores;
    const now = new Date(this.now());
    if (cur.importOpId) {
      const op = await this.deps.ops.get(cur.importOpId);
      if (op && !ENDED.has(op.state)) return cur;
      const data = isRecord(op?.result?.data) ? op.result.data : {};
      const done = op?.state === 'completed' && data['ok'] !== false;
      const set = done
        ? { state: 'done' as const, backupId: typeof data['backupId'] === 'string' ? data['backupId'] : null, endedAt: now }
        : { state: 'failed' as const, code: op?.result?.code ?? (typeof data['code'] === 'string' ? data['code'] : (op?.state ?? 'lost')), endedAt: now };
      logger.warn({ mergeId: cur._id, importOpId: cur.importOpId, opState: op?.state ?? null, to: set.state }, 'biforesting-sync: quest party merge settled from its import op');
      return (await merges.update(cur._id, cur.runId, set)) ?? ((await merges.get(cur._id)) ?? cur);
    }
    const owner = await ledger.get(cur.group, cur.uuid);
    if (owner?.lease?.holder === cur.runId && owner.lease.until.getTime() > now.getTime()) return cur;
    return (await merges.update(cur._id, cur.runId, { state: 'failed', code: 'lost', endedAt: now })) ?? ((await merges.get(cur._id)) ?? cur);
  }

  // ── Ops ────────────────────────────────────────────────────────────────────

  /**
   * Creates one quest op that expires at `deadline`, dispatches it and waits for its result until
   * then. Answers the result data of a completed op. Throws a {@link QuestOpError} otherwise: 409
   * `not_ready` from a mod build without the op, 409 with the mod's code and a fixed line for
   * another failure, 502 `op_failed` for a failure without a code, 409 `player_offline` for a
   * parked op, 409 `timeout` when no result came in time. An op still before its ack at the
   * deadline is cancelled. `onCreated` runs after the create and before the dispatch.
   */
  private async call(
    serverId: string,
    type: string,
    params: Record<string, unknown>,
    target: OpTarget | null,
    actor: string,
    members: GroupMember[],
    deadline: number,
    opts: { offlineCode?: 'instance_offline' | 'source_offline'; onCreated?: (op: OpDoc) => Promise<void> } = {},
  ): Promise<{ op: OpDoc; data: Record<string, unknown> }> {
    const label = instanceLabel(members, serverId);
    const timeout = (unsettled: boolean, details: Record<string, unknown>): QuestOpError =>
      new QuestOpError(409, 'timeout', `${label} did not answer in time. Check /quests again in a moment.`, unsettled, details);
    const inst = await this.deps.directory.instanceOf(serverId);
    if (!inst) throw new SyncConflictError(opts.offlineCode ?? 'instance_offline', `${label} is not reachable right now. Try again later.`, { serverId });
    const parsed = catalogEntry(type)!.params.safeParse(params);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      if (type === 'quests_import_party') throw new QuestOpError(502, 'bad_export', QUEST_MESSAGES.badExport, false, { type, detail });
      throw new QuestOpError(400, 'bad_value', `${type}: ${detail}`, false, { type });
    }
    const left = deadline - this.now();
    if (left < MIN_OP_MS) throw timeout(false, { type, serverId });
    const { op } = await this.deps.ops.create({
      instanceKey: inst.instanceKey,
      serverTag: inst.tag,
      type,
      params: parsed.data as Record<string, unknown>,
      target,
      ...QUEST_OP_DEFAULTS,
      expiresInMs: left,
      createdBy: `sync-quests (${actor})`,
    });
    if (opts.onCreated) await opts.onCreated(op);
    const end = await this.waitEnded(op, deadline);
    const details = { type, opId: op._id, serverId };

    if (end.state === 'completed') return { op: end, data: isRecord(end.result?.data) ? end.result.data : {} };
    if (end.state === 'failed') {
      const code = end.result?.code;
      // The error text can hold Java exception text. Only the log gets it.
      logger.warn({ ...details, code: code ?? null, error: end.result?.error ?? null }, 'biforesting-sync: quest op failed');
      if (code === 'unsupported_op') {
        throw new QuestOpError(409, 'not_ready', `Quest options need a newer mod version on ${label}.`, false, details);
      }
      if (code === 'feature_off') throw new QuestOpError(409, 'feature_missing', `Quest options are not open on ${label} yet.`, false, details);
      if (code) throw new QuestOpError(409, modCode(code), QUEST_MESSAGES.refused, false, details);
      // No code: the dispatcher gave up on it. After an ack it may still run there.
      throw new QuestOpError(502, 'op_failed', `${label} could not run it.`, end.ackedAt !== null, details);
    }
    if (end.state === 'waiting_player') {
      const cancelled = await this.deps.ops.cancel(end._id, 'sync-quests');
      throw new QuestOpError(409, 'player_offline', QUEST_MESSAGES.playerOffline, cancelled === null, details);
    }
    if (!ENDED.has(end.state)) await this.deps.ops.cancel(end._id, 'sync-quests (no result in time)');
    throw timeout(end.dispatchedAt !== null || end.ackedAt !== null, details);
  }

  /** Dispatches `op` and waits until it reaches an end state or the `deadline` passes. */
  private async waitEnded(op: OpDoc, deadline: number): Promise<OpDoc> {
    let fired = false;
    let wake: (() => void) | null = null;
    const onEnd = (): void => {
      fired = true;
      wake?.();
    };
    this.ended.on(op._id, onEnd);
    try {
      await this.deps.dispatch.onOpCreated(op);
      let cur: OpDoc = op;
      for (;;) {
        fired = false;
        cur = (await this.deps.ops.get(op._id)) ?? cur;
        if (ENDED.has(cur.state)) return cur;
        const left = deadline - this.now();
        if (left <= 0) return cur;
        if (!fired) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, Math.min(left, this.timing.pollMs));
            wake = (): void => {
              clearTimeout(timer);
              resolve();
            };
          });
        }
        wake = null;
      }
    } finally {
      this.ended.off(op._id, onEnd);
    }
  }
}
