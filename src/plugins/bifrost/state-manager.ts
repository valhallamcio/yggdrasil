import type WebSocket from 'ws';
import { eventBus } from '../../core/event-bus/index.js';
import { logger } from '../../core/logger/index.js';
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

class BifrostStateManager {
  private players = new Map<string, PlayerState>();
  private servers = new Map<string, ServerStatus>();
  private activeWs: WebSocket | null = null;
  connected = false;

  constructor() {
    eventBus.on('server.stats', ({ server, stats }) => {
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
    logger.warn('Bifrost proxy disconnected — emitting synthetic player.left for all tracked players');

    for (const state of this.players.values()) {
      eventBus.emit('player.left', {
        username: state.username,
        uuid: state.uuid,
        ip: state.ip,
        server: state.server,
      });
    }
    this.players.clear();
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

    // Reconcile: emit synthetic events for discrepancies
    for (const [username, info] of incoming) {
      const existing = this.players.get(username);
      if (!existing) {
        // Missed join event
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
        this.players.delete(username);
        eventBus.emit('player.left', { username, uuid: state.uuid, ip: state.ip, server: state.server });
      }
    }

    // Emit updated list for stats recorder / peak tracker
    const servers: Record<string, Array<{ username: string; ping: number }>> = {};
    for (const [server, players] of Object.entries(p.servers)) {
      servers[server] = players.map((pl) => ({ username: pl.username, ping: pl.ping }));
    }
    eventBus.emit('player.list.updated', { servers, count: p.count });
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
