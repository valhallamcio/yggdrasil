import { eventBus } from '../../core/event-bus/index.js';
import { logger } from '../../core/logger/index.js';
import { UUID_RE } from './decoders.js';
import { FEATURE_BITS, featureNamesForMask } from './policy-store.js';
import { toSyncStamp, type PresenceEvent, type SyncLedgerStore, type SyncPlayerDoc, type SyncPlayerState } from './sync-ledger-store.js';
import type { SyncGroupDoc, SyncGroupsStore } from './sync-groups-store.js';
import type { SyncSnapshotMeta, SyncSnapshotStore } from './sync-snapshot-store.js';
import type { ShadowReason, SyncShadowStore } from './sync-shadow-store.js';
import type { GroupMember } from './server-resolver.js';
import type { SyncSink } from './link-manager.js';
import type { DecodedSyncSnap, LinkIdentity, PresenceMsg, PresencePlayer, SyncStamp } from './types.js';

const PLAYER_SYNC = FEATURE_BITS['player_sync']!;

/** Bifrost instance-group membership (the server resolver in production). */
export interface SyncDirectory {
  groupOf(serverId: string): Promise<string | null>;
  groupMembers(group: string): Promise<GroupMember[]>;
}

export interface SyncInstanceLink {
  instanceKey: string;
  /** The bits the live session holds: stored policy AND advertised capabilities. */
  grantedFeatures: number;
  /** Fingerprint from the register tail, or null without one. */
  fp: string | null;
}

/** Live link facts by Pterodactyl serverId (the link manager in production). */
export interface SyncLinkPort {
  /** Null when the instance has no live, resolved session. */
  instance(serverId: string): Promise<SyncInstanceLink | null>;
}

/** One instance of one group. */
export interface SyncAt {
  group: string;
  /** Pterodactyl serverId. */
  serverId: string;
}

/** Live-mode work (the S2 move runner): moves, the detector and disowns. Each method says when it runs. */
export interface SyncLiveHooks {
  /** Live groups only, after the ledger presence update. `stamp` is null when absent or of another group. */
  onPresence(at: SyncAt, event: PresenceEvent, player: PresencePlayer, stamp: SyncStamp | null, doc: SyncPlayerDoc | null): Promise<void>;
  /** After a `release` syncsnap is stored, in any mode. */
  onReleaseSnapshot(at: SyncAt, snapshot: SyncSnapshotMeta): Promise<void>;
  /**
   * A member registered or got a re-sent reg_ack, in any group mode. `live` is true when the group
   * is in mode live. Open moves still finish outside live mode, so they need this too.
   */
  onMemberLinkUp(group: string, serverId: string, live: boolean): Promise<void>;
}

export interface SyncStores {
  groups: SyncGroupsStore;
  ledger: SyncLedgerStore;
  snapshots: SyncSnapshotStore;
  shadow: SyncShadowStore;
}

export type SyncGroupView = Omit<SyncGroupDoc, '_id'> & { group: string };

export interface SyncInstanceStatus {
  serverId: string;
  instanceNumber: number | null;
  name: string;
  live: boolean;
  features: string[];
  fp: string | null;
  /** True when this instance is live and every live member shares one fingerprint. */
  fpMatch: boolean;
}

export interface SyncGroupStatus extends SyncGroupView {
  instances: SyncInstanceStatus[];
  counts: Record<SyncPlayerState, number>;
}

export interface ShadowVerdict {
  verdict: 'ok' | 'blocked';
  reasons: ShadowReason[];
}

export function groupView(doc: SyncGroupDoc): SyncGroupView {
  const { _id, ...rest } = doc;
  return { group: _id, ...rest };
}

/**
 * Yggdrasil side of player sync S1, shadow mode (bifrost-lib `docs/invariants/player-sync.md`
 * 6.5): the ledger from presence, snapshot storage and shadow-move verdicts. It never changes an
 * owner and never sends anything to a server. Group mode `off` stops the presence and shadow
 * snapshot work. In mode `live` it hands presence and link-ups to the live hooks (S2).
 */
export class SyncService implements SyncSink {
  constructor(
    private readonly stores: SyncStores,
    private readonly directory: SyncDirectory,
    private readonly links: SyncLinkPort,
    private readonly live: SyncLiveHooks | null = null,
  ) {}

  /** Presence join, quit or snapshot from a resolved session. A failed player update logs and goes on. */
  async onPresence(identity: LinkIdentity, msg: PresenceMsg): Promise<void> {
    const at = await this.groupOfSession(identity);
    if (!at) return;
    const mode = (await this.stores.groups.get(at.group)).mode;
    if (mode === 'off') return;
    const players = msg.event === 'snapshot' ? (msg.online ?? []) : msg.player ? [msg.player] : [];
    for (const p of players) {
      if (typeof p?.uuid !== 'string' || !UUID_RE.test(p.uuid)) continue;
      const player: PresencePlayer = { uuid: p.uuid.toLowerCase(), name: typeof p.name === 'string' ? p.name : '' };
      const raw = msg.event === 'quit' ? null : toSyncStamp(p.sync);
      // A stamp of another group says nothing about this one: treat it as absent.
      const stamp = raw && raw.g === at.group ? raw : null;
      try {
        const doc = await this.stores.ledger.upsertFromPresence(at.group, player.uuid, player.name, at.serverId, msg.event, stamp, mode);
        if (mode === 'live' && this.live) await this.live.onPresence(at, msg.event, player, stamp, doc);
      } catch (err) {
        logger.warn({ err, group: at.group, uuid: p.uuid, event: msg.event }, 'biforesting-sync: ledger presence update failed');
      }
    }
  }

  /**
   * One decoded `biforesting:syncsnap`. It is stored under the sending server's serverId and the
   * group of its server doc. A snapshot that names another group is dropped. Mode `off` drops
   * shadow snapshots only: release and pre_sync come from move ops, which S1 never sends,
   * pre_action is the central backup of a quest write (phase6 DESIGN 5.3), and party_export is
   * the record of a party merge.
   */
  async onSyncSnap(identity: LinkIdentity, snap: DecodedSyncSnap): Promise<void> {
    const { header, gz } = snap;
    const ctx = { instanceKey: identity.instanceKey, serverId: identity.serverId, uuid: header.uuid, kind: header.kind };
    const at = await this.groupOfSession(identity);
    if (!at) {
      logger.warn(ctx, 'biforesting-sync: syncsnap dropped, the sender has no serverId or is in no group');
      return;
    }
    if (header.group !== undefined && header.group !== at.group) {
      logger.warn({ ...ctx, group: at.group, headerGroup: header.group }, 'biforesting-sync: syncsnap dropped, it names another group');
      return;
    }
    if (header.kind === 'shadow' && (await this.stores.groups.get(at.group)).mode === 'off') {
      logger.debug({ ...ctx, group: at.group }, 'biforesting-sync: shadow syncsnap dropped, group mode is off');
      return;
    }

    const { snapshot, duplicate } = await this.stores.snapshots.insert({ group: at.group, serverId: at.serverId, header, gz });
    const h = snapshot.header;
    eventBus.emit('biforesting.sync.snapshot', {
      snapshotId: snapshot._id,
      group: snapshot.group,
      serverId: snapshot.serverId,
      instanceKey: identity.instanceKey,
      duplicate,
      kind: h.kind,
      uuid: h.uuid,
      name: h.name,
      v: h.v,
      moveId: h.moveId ?? null,
      fp: h.fp ?? null,
      dv: h.dv ?? null,
      sha256: h.sha256,
      gzLen: h.gzLen,
      rawLen: h.rawLen ?? null,
      blocked: h.blocked,
      links: h.links,
      worldData: h.worldData,
      playerData: h.playerData,
      tookMs: h.tookMs ?? null,
      at: h.at ?? null,
    });
    logger.info(
      { ...ctx, group: at.group, snapshotId: snapshot._id, gzLen: gz.length, blocked: h.blocked.length, duplicate },
      'biforesting-sync: snapshot stored',
    );
    if (h.kind === 'release' && this.live) {
      try {
        await this.live.onReleaseSnapshot(at, snapshot);
      } catch (err) {
        logger.warn({ err, ...ctx, snapshotId: snapshot._id }, 'biforesting-sync: release snapshot check failed');
      }
    }
  }

  /**
   * A resolved session registered or got a re-sent reg_ack. The runner drives the open moves of
   * the member, and in a live group it also reconciles the member's disowns, owns and world-data locks.
   */
  async onLinkUp(identity: LinkIdentity): Promise<void> {
    if (!this.live) return;
    const at = await this.groupOfSession(identity);
    if (!at) return;
    await this.live.onMemberLinkUp(at.group, at.serverId, (await this.stores.groups.get(at.group)).mode === 'live');
  }

  /** GET /sync/:group. */
  async groupStatus(group: string): Promise<SyncGroupStatus> {
    const doc = await this.stores.groups.get(group);
    const members = await this.directory.groupMembers(group);
    const linked = await Promise.all(members.map(async (m) => ({ m, link: await this.links.instance(m.serverId) })));
    const liveFps = linked.flatMap(({ link }) => (link ? [link.fp] : []));
    const oneFp = liveFps.length > 0 && liveFps.every((fp) => fp !== null && fp === liveFps[0]);
    const instances = linked.map(({ m, link }) => ({
      serverId: m.serverId,
      instanceNumber: m.instanceNumber,
      name: m.name,
      live: link !== null,
      features: link ? featureNamesForMask(link.grantedFeatures) : [],
      fp: link?.fp ?? null,
      fpMatch: link !== null && oneFp,
    }));
    return { ...groupView(doc), instances, counts: await this.stores.ledger.countByState(group) };
  }

  /**
   * POST /sync/:group/players/:uuid/shadow-move (spec 6.5). Lists every failed check, stores the
   * verdict and returns it. It moves nothing.
   */
  async shadowMove(group: string, uuid: string, from: string, to: string): Promise<ShadowVerdict> {
    const reasons: ShadowReason[] = [];
    const doc = await this.stores.groups.get(group);
    const members = new Set((await this.directory.groupMembers(group)).map((m) => m.serverId));

    const ends = new Map<string, SyncInstanceLink | null>();
    for (const serverId of [from, to]) {
      if (!members.has(serverId)) {
        reasons.push({ code: 'not_member', serverId });
        continue;
      }
      const link = await this.links.instance(serverId);
      ends.set(serverId, link);
      if (!link) reasons.push({ code: 'no_link', serverId });
      else if ((link.grantedFeatures & PLAYER_SYNC) === 0) reasons.push({ code: 'feature_off', serverId });
    }
    const a = ends.get(from);
    const b = ends.get(to);
    if (a && b && (a.fp === null || a.fp !== b.fp)) {
      reasons.push({ code: 'fingerprint_mismatch', detail: `${from}=${a.fp ?? 'none'} ${to}=${b.fp ?? 'none'}` });
    }
    if (doc.frozen) reasons.push({ code: 'frozen', ...(doc.freezeReason ? { detail: doc.freezeReason } : {}) });

    const snap = await this.stores.snapshots.newest(group, uuid, 'shadow');
    if (!snap) reasons.push({ code: 'no_snapshot' });
    else if (snap.header.blocked.length > 0) {
      reasons.push({ code: 'blocked_items', snapshotId: snap._id, blocked: snap.header.blocked });
    }

    const verdict: ShadowVerdict = { verdict: reasons.length === 0 ? 'ok' : 'blocked', reasons };
    await this.stores.shadow.insert({ group, uuid: uuid.toLowerCase(), from, to, at: new Date(), ...verdict });
    return verdict;
  }

  private async groupOfSession(identity: LinkIdentity): Promise<{ serverId: string; group: string } | null> {
    if (!identity.serverId) return null;
    const group = await this.directory.groupOf(identity.serverId);
    return group ? { serverId: identity.serverId, group } : null;
  }
}
