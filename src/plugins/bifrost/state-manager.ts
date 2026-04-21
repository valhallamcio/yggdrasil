import type WebSocket from 'ws';
import { eventBus } from '../../core/event-bus/index.js';
import { logger } from '../../core/logger/index.js';
import { ServersRepository } from '../../domains/servers/servers.repository.js';
import type { OnlinePlayerDto } from '../../domains/players/players.types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PlayerState {
  username: string;
  uuid: string;
  ip: string;
  server: string;
  ping: number;
  position: { x: number; y: number; z: number } | null;
  joinedAt: Date;
  lastSeen: Date;
}

export interface ServerStatus {
  tag: string;
  state: string;
  cpu: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  diskBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
  uptime: number;
  tps: number;
  players: number;
  lastUpdated: string;
}

export interface ProxyStateSnapshot {
  connected: boolean;
  players: PlayerState[];
  count: number;
  servers: ServerStatus[];
  timestamp: string;
}

// ── Inbound message shapes (from Bifrost) ────────────────────────────────────

interface JoinedPayload { username: string; uuid: string; ip: string; server: string }
interface LeftPayload { username: string; uuid: string; ip: string; server: string }
interface ServerChangedPayload { username: string; uuid: string; ip: string; previousServer: string; currentServer: string }
interface ListUpdatedPayload { servers: Record<string, Array<{ username: string; uuid?: string; ping: number }>>; count: number }
interface MessagePayload { username: string; uuid: string; server: string; message: string }
interface PositionPayload { username: string; server: string; x: number; y: number; z: number }

// ── State Manager ────────────────────────────────────────────────────────────

const SHARD_SYNC_INTERVAL_MS = 10_000;

class BifrostStateManager {
  private players = new Map<string, PlayerState>();
  private servers = new Map<string, ServerStatus>();
  private activeWs: WebSocket | null = null;
  connected = false;
  private readonly serversRepo = new ServersRepository();
  private shardSyncTimer: NodeJS.Timeout | null = null;

  constructor() {
    eventBus.on('server.stats', ({ server, stats }) => {
      const existing = this.servers.get(server);
      const entry: ServerStatus = {
        tag: server,
        state: stats.state,
        cpu: stats.cpu_absolute,
        memoryBytes: stats.memory_bytes,
        memoryLimitBytes: stats.memory_limit_bytes,
        diskBytes: stats.disk_bytes,
        networkRxBytes: stats.network.rx_bytes,
        networkTxBytes: stats.network.tx_bytes,
        uptime: stats.uptime,
        tps: existing?.tps ?? 0,
        players: this.countPlayersOn(server),
        lastUpdated: new Date().toISOString(),
      };
      this.servers.set(server, entry);
      this.sendToProxy('server.stats', entry);
    });

    eventBus.on('server.state.changed', ({ server, previousState, currentState }) => {
      const existing = this.servers.get(server);
      if (existing) existing.state = currentState;
      this.sendToProxy('server.state.changed', { tag: server, previousState, currentState });
    });

    this.startShardSync();
  }

  /** Count players currently on a given server tag. */
  private countPlayersOn(tag: string): number {
    let n = 0;
    for (const p of this.players.values()) if (p.server === tag) n++;
    return n;
  }

  /** Refresh players counts on every entry from current player map. */
  private refreshPlayerCounts(): void {
    for (const entry of this.servers.values()) {
      entry.players = this.countPlayersOn(entry.tag);
    }
  }

  /** Periodically fetch shard docs and hydrate tps + players onto ServerStatus entries. */
  private startShardSync(): void {
    const sync = async (): Promise<void> => {
      try {
        const shards = await this.serversRepo.findAllShards();
        const docs = await this.serversRepo.findAll();
        for (const shard of shards) {
          const doc = docs.find((d) => d._id.equals(shard.server));
          if (!doc) continue;
          const entry = this.servers.get(doc.tag);
          if (!entry) continue;
          entry.tps = Math.round(shard.tps * 100) / 100;
          // Prefer live player count from our in-memory map; fall back to shard.
          entry.players = this.countPlayersOn(doc.tag) || shard.players;
        }
      } catch (err) {
        logger.debug({ err }, 'BifrostStateManager: shard sync failed');
      }
    };
    void sync();
    this.shardSyncTimer = setInterval(() => void sync(), SHARD_SYNC_INTERVAL_MS);
  }

  stopShardSync(): void {
    if (this.shardSyncTimer) {
      clearInterval(this.shardSyncTimer);
      this.shardSyncTimer = null;
    }
  }

  // ── Outbound ─────────────────────────────────────────────────────────────

  private sendToProxy(type: string, payload: unknown): void {
    if (!this.activeWs) return;
    try {
      this.activeWs.send(JSON.stringify({ type, payload }));
    } catch (err) {
      logger.debug({ err, type }, 'BifrostStateManager: failed to send message to proxy');
    }
  }

  // ── Connection lifecycle ─────────────────────────────────────────────────

  setConnected(ws: WebSocket): void {
    this.activeWs = ws;
    this.connected = true;
    logger.info('Bifrost proxy connected');
  }

  onDisconnect(ws: WebSocket): void {
    if (ws !== this.activeWs) return;
    this.connected = false;
    this.activeWs = null;
    logger.warn('Bifrost proxy disconnected — keeping tracked player state intact; next connected snapshot will reconcile');

    // Intentionally NOT emitting synthetic `player.left` here. Downstream SSE
    // consumers would see their cached counts decrement to zero and flash
    // empty rows during a brief reconnect. The next proxy.state snapshot
    // after reconnect is authoritative and will fix any drift.
    // this.players is retained so a reconnect without player changes stays
    // a no-op from the client's perspective.
  }

  // ── Message routing ──────────────────────────────────────────────────────

  handleMessage(type: string, payload: Record<string, unknown>): void {
    switch (type) {
      case 'player.joined':
        this.onJoined(payload as unknown as JoinedPayload);
        break;
      case 'player.left':
        this.onLeft(payload as unknown as LeftPayload);
        break;
      case 'player.server.changed':
        this.onServerChanged(payload as unknown as ServerChangedPayload);
        break;
      case 'player.list.updated':
        this.onListUpdated(payload as unknown as ListUpdatedPayload);
        break;
      case 'player.message':
        this.onMessage(payload as unknown as MessagePayload);
        break;
      case 'player.position':
        this.onPosition(payload as unknown as PositionPayload);
        break;
      case 'player.inventory':
        // No-op: signal only, no data to act on
        break;
      default:
        logger.debug({ type }, 'BifrostStateManager: unhandled message type');
    }
  }

  // ── Handlers ─────────────────────────────────────────────────────────────

  private onJoined(p: JoinedPayload): void {
    if (this.players.has(p.username)) return; // already tracked — skip duplicate

    this.players.set(p.username, {
      username: p.username,
      uuid: p.uuid,
      ip: p.ip,
      server: p.server,
      ping: 0,
      position: null,
      joinedAt: new Date(),
      lastSeen: new Date(),
    });

    const entry = this.servers.get(p.server);
    if (entry) entry.players = this.countPlayersOn(p.server);

    eventBus.emit('player.joined', {
      username: p.username,
      uuid: p.uuid,
      ip: p.ip,
      server: p.server,
      ping: 0,
    });
  }

  private onLeft(p: LeftPayload): void {
    const state = this.players.get(p.username);
    if (!state) return;
    this.players.delete(p.username);

    const entry = this.servers.get(state.server);
    if (entry) entry.players = this.countPlayersOn(state.server);

    eventBus.emit('player.left', {
      username: p.username,
      uuid: p.uuid ?? state.uuid,
      ip: p.ip ?? state.ip,
      server: p.server ?? state.server,
    });
  }

  private onServerChanged(p: ServerChangedPayload): void {
    const state = this.players.get(p.username);
    if (state) {
      state.server = p.currentServer;
      state.lastSeen = new Date();
    }

    const prevEntry = this.servers.get(p.previousServer);
    if (prevEntry) prevEntry.players = this.countPlayersOn(p.previousServer);
    const currEntry = this.servers.get(p.currentServer);
    if (currEntry) currEntry.players = this.countPlayersOn(p.currentServer);

    eventBus.emit('player.server.changed', {
      username: p.username,
      uuid: p.uuid,
      ip: p.ip,
      previousServer: p.previousServer,
      currentServer: p.currentServer,
    });
  }

  private onListUpdated(p: ListUpdatedPayload): void {
    // Build canonical map from the authoritative list
    const incoming = new Map<string, { uuid: string; server: string; ping: number }>();
    for (const [server, players] of Object.entries(p.servers)) {
      for (const player of players) {
        incoming.set(player.username, { uuid: player.uuid ?? '', server, ping: player.ping });
      }
    }

    let missedJoins = 0;
    let missedLeaves = 0;

    // Reconcile: emit synthetic events for discrepancies
    for (const [username, info] of incoming) {
      const existing = this.players.get(username);
      if (!existing) {
        // Missed join event
        missedJoins++;
        this.players.set(username, {
          username,
          uuid: info.uuid,
          ip: '',
          server: info.server,
          ping: info.ping,
          position: null,
          joinedAt: new Date(),
          lastSeen: new Date(),
        });
        eventBus.emit('player.joined', { username, uuid: info.uuid, ip: '', server: info.server, ping: info.ping });
      } else {
        // Update ping always
        existing.ping = info.ping;
        existing.lastSeen = new Date();
        if (existing.uuid === '' && info.uuid) existing.uuid = info.uuid;

        if (existing.server !== info.server) {
          // Missed server change
          const prev = existing.server;
          existing.server = info.server;
          eventBus.emit('player.server.changed', {
            username,
            uuid: existing.uuid,
            ip: existing.ip,
            previousServer: prev,
            currentServer: info.server,
          });
        }
      }
    }

    // Reconcile: synthetic leaves for players no longer in the list
    for (const [username, state] of this.players) {
      if (!incoming.has(username)) {
        missedLeaves++;
        this.players.delete(username);
        eventBus.emit('player.left', { username, uuid: state.uuid, ip: state.ip, server: state.server });
      }
    }

    if (missedJoins > 0 || missedLeaves > 0) {
      logger.warn(
        { missedJoins, missedLeaves, rawCount: p.count, reconciledCount: this.players.size },
        'Bifrost list reconciliation detected discrepancies',
      );
    }

    this.refreshPlayerCounts();

    // Emit updated list from reconciled state (not raw payload)
    const servers: Record<string, Array<{ username: string; ping: number }>> = {};
    for (const state of this.players.values()) {
      let list = servers[state.server];
      if (!list) {
        list = [];
        servers[state.server] = list;
      }
      list.push({ username: state.username, ping: state.ping });
    }
    eventBus.emit('player.list.updated', { servers, count: this.players.size });
  }

  private onMessage(p: MessagePayload): void {
    const state = this.players.get(p.username);
    if (state) state.lastSeen = new Date();

    eventBus.emit('player.chat', {
      username: p.username,
      uuid: p.uuid,
      server: p.server,
      message: p.message,
    });
  }

  private onPosition(p: PositionPayload): void {
    const state = this.players.get(p.username);
    if (!state) return;
    state.position = { x: p.x, y: p.y, z: p.z };
    state.lastSeen = new Date();
  }

  // ── Snapshot ─────────────────────────────────────────────────────────────

  getSnapshot(): ProxyStateSnapshot {
    return {
      connected: this.connected,
      players: Array.from(this.players.values()),
      count: this.players.size,
      servers: Array.from(this.servers.values()),
      timestamp: new Date().toISOString(),
    };
  }

  // ── Query API (replaces MetricsCollector interface) ───────────────────────

  get count(): number {
    return this.players.size;
  }

  isOnline(username: string): boolean {
    return this.players.has(username);
  }

  getPlayerInfo(username: string): { server: string; ping: number } | undefined {
    const state = this.players.get(username);
    if (!state) return undefined;
    return { server: state.server, ping: state.ping };
  }

  getOnlinePlayers(): Record<string, OnlinePlayerDto[]> {
    const grouped: Record<string, OnlinePlayerDto[]> = {};
    for (const state of this.players.values()) {
      let list = grouped[state.server];
      if (!list) {
        list = [];
        grouped[state.server] = list;
      }
      list.push({ username: state.username, server: state.server, ping: state.ping });
    }
    return grouped;
  }
}

export const bifrostStateManager = new BifrostStateManager();
