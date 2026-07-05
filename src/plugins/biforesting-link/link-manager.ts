import { eventBus } from '../../core/event-bus/index.js';
import { logger } from '../../core/logger/index.js';
import { getAuthKey } from './auth-key.js';
import { encodeFrames, encodeOuterUnit } from './frame-codec.js';
import { decodeMetrics, decodeRegistry, decodeQuest, decodeChunks, decodeRegister, decodeOpRes, decodePresence, decodeInvSnap, decodeQuestReg, encodeRegAck } from './decoders.js';
import { saveInvSnapshot } from './inv-store.js';
import { saveQuestRegistry } from './quest-registry-store.js';
import { saveMetrics } from './metrics-history.js';
import { saveRegistry, saveQuests, saveChunks } from './persistence.js';
import { getPolicy, ZERO_POLICY } from './policy-store.js';
import { serverResolver } from './server-resolver.js';
import type { LinkIdentity, LinkMetrics, LinkSnapshot, LinkSessionSnapshot, OpResMsg, PresenceMsg, RegisterInfo } from './types.js';

const HELLO = 'biforesting:hello';
const REGISTER = 'biforesting:register';
const REG_ACK = 'biforesting:reg_ack';
const METRICS = 'biforesting:metrics';
const REGISTRY = 'biforesting:registry';
const QUEST = 'biforesting:quest';
const CHUNKS = 'biforesting:chunks';
const OP_RES = 'biforesting:op_res';
const PRESENCE = 'biforesting:presence';
const INVSNAP = 'biforesting:invsnap';
const QUESTREG = 'biforesting:questreg';

/**
 * Where op_res/presence messages and link-up notifications go (the op dispatcher). Wired by the
 * plugin's init via {@link BiforestingLinkManager.setOpSink} — keeps this module free of an
 * import cycle with the ops runtime.
 */
export interface OpSink {
  onOpRes(instanceKey: string, msg: OpResMsg): Promise<void>;
  onPresence(instanceKey: string, msg: PresenceMsg): Promise<void>;
  onLinkUp(instanceKey: string): Promise<void>;
}

/** Highest link semantics version this Yggdrasil speaks. */
const LINK_PROTOCOL_VERSION = 2;

/**
 * Transport-agnostic handle for a single live link session. Lets the manager drive DOWN
 * sends/closes without knowing whether the backend dialed in over raw TCP (`socket.write`)
 * or over a `/biforesting/` WebSocket (`ws.send`). Each method takes/returns a fully-framed
 * outer unit (`[uint16 chanLen][channel][int32 frameLen][frame]`).
 */
export interface LinkTransport {
  /** True while the underlying connection can still accept a DOWN write. */
  writable(): boolean;
  /** Write one complete outer unit to the backend. */
  send(outerUnit: Buffer): void;
  /** Tear the connection down (graceful shutdown / duplicate eviction). */
  close(): void;
}

interface Session {
  sessionId: string;
  transport: LinkTransport;
  remote: string;
  identity: LinkIdentity | null;
  connectedAt: number;
  lastFrameAt: number | null;
  bytesIn: number;
  framesAccepted: number;
  framesRejected: number;
  metrics: LinkMetrics | null;
  registryCount: number;
  questTeams: number;
  chunkTeams: number;
  lastDataVersion: number | null;
  /** Metadata from the `biforesting:register` handshake, if the mod sent one. */
  register: RegisterInfo | null;
  /** Per-session serialization tail: ensures `hello` resolves identity before later channels run. */
  tail: Promise<void>;
}

/**
 * Singleton tracking all live play-phase link sessions (the `bifrost/state-manager.ts` analog for
 * the raw-TCP link). The TCP plugin owns the sockets + codec; this owns session state, channel
 * dispatch, persistence, DOWN sends, and the observability snapshot read by the REST router.
 */
class BiforestingLinkManager {
  private readonly sessions = new Map<string, Session>();
  listening = false;
  private downSeq = 0;
  private opSink: OpSink | null = null;

  /** Wire the op dispatcher (plugin init). */
  setOpSink(sink: OpSink | null): void {
    this.opSink = sink;
  }

  /** instanceKeys of all live, identity-resolved sessions (op dispatch sweep). */
  liveInstanceKeys(): string[] {
    const keys: string[] = [];
    for (const s of this.sessions.values()) {
      if (s.identity?.resolved && s.transport.writable()) keys.push(s.identity.instanceKey);
    }
    return keys;
  }

  // ── Session lifecycle ──────────────────────────────────────────────────────

  registerSession(sessionId: string, transport: LinkTransport, remote: string): void {
    this.sessions.set(sessionId, {
      sessionId,
      transport,
      remote,
      identity: null,
      connectedAt: Date.now(),
      lastFrameAt: null,
      bytesIn: 0,
      framesAccepted: 0,
      framesRejected: 0,
      metrics: null,
      registryCount: 0,
      questTeams: 0,
      chunkTeams: 0,
      lastDataVersion: null,
      register: null,
      tail: Promise.resolve(),
    });
  }

  removeSession(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    logger.info(
      { sessionId, instanceKey: s.identity?.instanceKey ?? null, linkServerId: s.identity?.linkServerId ?? null },
      'biforesting-link: session closed',
    );
    eventBus.emit('biforesting.link.disconnected', {
      sessionId,
      linkServerId: s.identity?.linkServerId ?? null,
      instanceKey: s.identity?.instanceKey ?? null,
    });
  }

  noteBytes(sessionId: string, n: number): void {
    const s = this.sessions.get(sessionId);
    if (s) s.bytesIn += n;
  }

  noteAccepted(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.framesAccepted += 1;
      s.lastFrameAt = Date.now();
    }
  }

  noteRejected(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.framesRejected += 1;
  }

  // ── Channel dispatch (one reassembled message) ─────────────────────────────

  /**
   * Enqueue a reassembled message. Messages for one session are handled strictly in arrival order
   * (chained on `session.tail`) so `hello` resolves the identity before `registry`/`quest`/`chunks`
   * — which arrive in the same TCP burst — try to persist against it.
   */
  dispatch(sessionId: string, channel: string, payload: Buffer): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return Promise.resolve();
    s.tail = s.tail
      .then(() => this.handle(s, channel, payload))
      .catch((err) => logger.warn({ err, sessionId, channel }, 'biforesting-link: failed to handle message'));
    return s.tail;
  }

  private async handle(s: Session, channel: string, payload: Buffer): Promise<void> {
    switch (channel) {
      case HELLO:
        await this.onHello(s, payload.toString('utf8'));
        break;
      case REGISTER:
        await this.onRegister(s, payload);
        break;
      case METRICS:
        this.onMetrics(s, decodeMetrics(payload));
        break;
      case REGISTRY:
        await this.onRegistry(s, payload);
        break;
      case QUEST:
        await this.onQuest(s, payload);
        break;
      case INVSNAP:
        if (s.identity?.resolved) {
          const snap = decodeInvSnap(payload);
          await saveInvSnapshot(s.identity, snap.header, snap.gz);
          eventBus.emit('biforesting.inv.snapshot', {
            instanceKey: s.identity.instanceKey,
            uuid: snap.header.uuid,
            name: snap.header.name,
            reason: snap.header.reason,
            sizeBytes: snap.gz.length,
          });
        }
        break;
      case QUESTREG:
        if (s.identity?.resolved) {
          const reg = decodeQuestReg(payload);
          await saveQuestRegistry(s.identity, reg);
          eventBus.emit('biforesting.questreg.updated', {
            instanceKey: s.identity.instanceKey,
            source: reg.source,
            count: reg.quests.length,
          });
        }
        break;
      case CHUNKS:
        await this.onChunks(s, payload);
        break;
      case OP_RES:
        if (s.identity?.resolved && this.opSink) {
          await this.opSink.onOpRes(s.identity.instanceKey, decodeOpRes(payload));
        }
        break;
      case PRESENCE:
        if (s.identity?.resolved && this.opSink) {
          await this.opSink.onPresence(s.identity.instanceKey, decodePresence(payload));
        }
        break;
      default:
        logger.debug({ sessionId: s.sessionId, channel, bytes: payload.length }, 'biforesting-link: unknown channel');
    }
  }

  private async onHello(s: Session, linkServerId: string): Promise<void> {
    const identity = await serverResolver.resolve(linkServerId);
    s.identity = identity;
    logger.info(
      {
        sessionId: s.sessionId,
        remote: s.remote,
        linkServerId,
        tag: identity.tag,
        instanceKey: identity.instanceKey,
        name: identity.name,
        resolved: identity.resolved,
      },
      'biforesting-link: hello — link identified',
    );
    eventBus.emit('biforesting.link.connected', {
      sessionId: s.sessionId,
      linkServerId,
      tag: identity.tag,
      instanceKey: identity.instanceKey,
      name: identity.name,
      serverId: identity.serverId,
      resolved: identity.resolved,
      remote: s.remote,
    });
  }

  /**
   * `biforesting:register` — the richer two-way handshake the mod sends right after `hello`.
   * Resolves identity the same way `hello` does, guards against a second live session claiming the
   * same instance, binds the session, then replies with `biforesting:reg_ack` DOWN this same link.
   */
  private async onRegister(s: Session, payload: Buffer): Promise<void> {
    const reg = decodeRegister(payload);
    s.register = reg;

    const identity = await serverResolver.resolve(reg.serverId);
    s.identity = identity;

    // Duplicate identity: NEWEST WINS. A restarted server must displace its own half-open
    // zombie session (the old socket often lingers until a TCP timeout). bootNonce tells a
    // restart (different nonce) from a config mistake (two servers, same id — also logged).
    const dup = this.findDuplicateSession(s, identity);
    if (dup) {
      logger.warn(
        {
          sessionId: s.sessionId,
          evictedSessionId: dup.sessionId,
          serverId: identity.serverId ?? reg.serverId,
          instanceKey: identity.instanceKey,
          oldBootNonce: dup.register?.bootNonce ?? null,
          newBootNonce: reg.bootNonce,
        },
        'biforesting-link: register — evicting older session bound to this identity (newest wins)',
      );
      try {
        dup.transport.close();
      } catch {
        /* already gone */
      }
      this.removeSession(dup.sessionId);
    }

    const canonicalServerId = identity.serverId ?? reg.serverId;
    const friendlyName = identity.name ?? '';
    const sent = await this.sendRegAck(s, canonicalServerId, friendlyName);

    logger.info(
      {
        sessionId: s.sessionId,
        remote: s.remote,
        linkServerId: reg.serverId,
        canonicalServerId,
        friendlyName,
        capabilities: `0x${reg.capabilities.toString(16)}`,
        node: reg.node,
        gameAddr: reg.gameAddr,
        bootNonce: reg.bootNonce,
        instanceKey: identity.instanceKey,
        accepted: identity.resolved,
        duplicate: !!dup,
        ackSent: sent,
      },
      `biforesting-link: registered ${friendlyName || '(unnamed)'} (${canonicalServerId}) ` +
        `caps=0x${reg.capabilities.toString(16)} node=${reg.node}`,
    );

    eventBus.emit('biforesting.link.connected', {
      sessionId: s.sessionId,
      linkServerId: reg.serverId,
      tag: identity.tag,
      instanceKey: identity.instanceKey,
      name: identity.name,
      serverId: identity.serverId,
      resolved: identity.resolved,
      remote: s.remote,
    });

    // Link-up: flush any ops queued while this backend was away (at-least-once; mod journal dedups).
    if (identity.resolved && this.opSink) {
      await this.opSink.onLinkUp(identity.instanceKey);
    }
  }

  /**
   * Build + send the authoritative reg_ack for a session from the CURRENT stored policy.
   * Unresolved identities and unknown servers get the ZERO policy — features stay off.
   */
  private async sendRegAck(s: Session, canonicalServerId: string, friendlyName: string): Promise<boolean> {
    const identity = s.identity;
    const accepted = !!identity?.resolved;
    const policy = accepted && identity ? await getPolicy(identity.instanceKey) : ZERO_POLICY;
    // Grant only bits the mod actually advertised: granted = policy ∩ capabilities.
    const caps = s.register?.capabilities ?? 0;
    const negotiatedVersion = Math.min(s.register?.linkProtocolVersion ?? 1, LINK_PROTOCOL_VERSION);
    const ack = encodeRegAck({
      accepted,
      canonicalServerId,
      friendlyName,
      enabledFeatures: policy.enabledFeatures & caps,
      metricsHz: policy.metricsHz,
      questHz: policy.questHz,
      chunkHz: policy.chunkHz,
      serverTimeMillis: Date.now(),
      negotiatedVersion,
    });
    return this.sendDownToSession(s, REG_ACK, ack);
  }

  /**
   * Re-send reg_ack to a live session after a policy change — the mod applies it immediately
   * (live per-server kill switch / grant, no reconnect or redeploy). False if no live session.
   */
  async resendRegAck(server: string): Promise<boolean> {
    const s = this.getSessionByServer(server);
    if (!s || !s.identity) return false;
    return this.sendRegAck(s, s.identity.serverId ?? s.identity.linkServerId, s.identity.name ?? '');
  }

  /** Find another live session bound to the same resolved identity (instanceKey/serverId). */
  private findDuplicateSession(self: Session, identity: LinkIdentity): Session | undefined {
    for (const other of this.sessions.values()) {
      if (other === self || !other.identity) continue;
      const oid = other.identity;
      if (
        oid.instanceKey === identity.instanceKey ||
        (identity.serverId !== null && oid.serverId === identity.serverId)
      ) {
        return other;
      }
    }
    return undefined;
  }

  private onMetrics(s: Session, metrics: LinkMetrics): void {
    s.metrics = metrics;
    if (!s.identity) return;
    eventBus.emit('biforesting.link.metrics', {
      instanceKey: s.identity.instanceKey,
      tag: s.identity.tag,
      serverId: s.identity.serverId,
      ...metrics,
    });
    void saveMetrics(s.identity, metrics); // best-effort history (plan D13)
  }

  private async onRegistry(s: Session, payload: Buffer): Promise<void> {
    const reg = decodeRegistry(payload);
    s.registryCount = reg.count;
    if (s.identity) {
      await saveRegistry(s.identity, reg);
      logger.info({ instanceKey: s.identity.instanceKey, count: reg.count }, 'biforesting-link: registry ingested');
      this.emitData(s, 'registry', reg.count);
    }
  }

  private async onQuest(s: Session, payload: Buffer): Promise<void> {
    const teams = decodeQuest(payload);
    s.questTeams = teams.length;
    if (teams[0]) s.lastDataVersion = teams[0].dataVersion;
    if (s.identity) {
      await saveQuests(s.identity, teams);
      this.emitData(s, 'quest', teams.length);
    }
  }

  private async onChunks(s: Session, payload: Buffer): Promise<void> {
    const teams = decodeChunks(payload);
    s.chunkTeams = teams.length;
    if (s.identity) {
      await saveChunks(s.identity, teams);
      this.emitData(s, 'chunks', teams.length);
    }
  }

  private emitData(s: Session, channel: 'registry' | 'quest' | 'chunks', count: number): void {
    if (!s.identity) return;
    eventBus.emit('biforesting.link.data', {
      instanceKey: s.identity.instanceKey,
      tag: s.identity.tag,
      serverId: s.identity.serverId,
      channel,
      count,
    });
  }

  // ── Queries / DOWN ─────────────────────────────────────────────────────────

  /** Match a session by linkServerId, instanceKey, Pterodactyl serverId, or tag. */
  getSessionByServer(server: string): Session | undefined {
    for (const s of this.sessions.values()) {
      const id = s.identity;
      if (!id) continue;
      if (id.linkServerId === server || id.instanceKey === server || id.serverId === server || id.tag === server) {
        return s;
      }
    }
    return undefined;
  }

  getLastDataVersion(server: string): number | null {
    return this.getSessionByServer(server)?.lastDataVersion ?? null;
  }

  /** Send an authoritative DOWN message to a session. Returns false if no live writable session. */
  sendDown(server: string, channel: string, payload: Buffer): boolean {
    const s = this.getSessionByServer(server);
    if (!s) return false;
    return this.sendDownToSession(s, channel, payload);
  }

  /**
   * Frame + write a DOWN message to a specific live session (shared by `sendDown` and the
   * register handshake's `reg_ack`). Returns false if the socket is gone. Mirrors the quest/chunks
   * DOWN path: signed `PlayFrameCodec` frames wrapped in the outer `[channel][frameLen][frame]` unit.
   */
  private sendDownToSession(s: Session, channel: string, payload: Buffer): boolean {
    if (!s.transport.writable()) return false;
    const messageId = (this.downSeq = (this.downSeq + 1) & 0x7fffffff);
    const frames = encodeFrames(channel, messageId, payload, Date.now(), getAuthKey());
    for (const frame of frames) {
      s.transport.send(encodeOuterUnit(channel, frame));
    }
    logger.info(
      { sessionId: s.sessionId, instanceKey: s.identity?.instanceKey ?? null, channel, frames: frames.length, bytes: payload.length },
      'biforesting-link: DOWN sent',
    );
    return true;
  }

  // ── Snapshot ───────────────────────────────────────────────────────────────

  private toSnapshot(s: Session): LinkSessionSnapshot {
    return {
      sessionId: s.sessionId,
      remote: s.remote,
      identity: s.identity,
      connectedAt: new Date(s.connectedAt).toISOString(),
      lastFrameAt: s.lastFrameAt ? new Date(s.lastFrameAt).toISOString() : null,
      bytesIn: s.bytesIn,
      framesAccepted: s.framesAccepted,
      framesRejected: s.framesRejected,
      metrics: s.metrics,
      registryCount: s.registryCount,
      questTeams: s.questTeams,
      chunkTeams: s.chunkTeams,
      lastDataVersion: s.lastDataVersion,
      register: s.register,
    };
  }

  getSnapshot(): LinkSnapshot {
    return {
      listening: this.listening,
      sessions: Array.from(this.sessions.values()).map((s) => this.toSnapshot(s)),
      count: this.sessions.size,
      timestamp: new Date().toISOString(),
    };
  }

  getSessionSnapshot(server: string): LinkSessionSnapshot | null {
    const s = this.getSessionByServer(server);
    return s ? this.toSnapshot(s) : null;
  }

  /** Close all sockets (graceful shutdown). */
  closeAll(): void {
    for (const s of this.sessions.values()) {
      try {
        s.transport.close();
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear();
  }
}

export const biforestingLinkManager = new BiforestingLinkManager();
