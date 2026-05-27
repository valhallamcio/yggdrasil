import WebSocket from 'ws';
import { logger } from '../../core/logger/index.js';
import { eventBus } from '../../core/event-bus/index.js';
import { PterodactylClient } from './pterodactyl.client.js';
import { ServersRepository } from './servers.repository.js';
import type { PterodactylStats } from './servers.types.js';
import type { ObjectId } from 'mongodb';

interface ServerEntry {
  serverId: string;
  tag: string;
  name: string;
  serverOid: ObjectId;
}

interface PterodactylWsEvent {
  event: string;
  args?: string[];
}

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 1_000;
const STUCK_STARTING_TIMEOUT_MS = 10 * 60_000; // 10 minutes
const STUCK_STOPPING_TIMEOUT_MS = 5 * 60_000;  // 5 minutes
const CRASH_LOOP_THRESHOLD = 3;
const CRASH_LOOP_WINDOW_MS = 15 * 60_000; // 15 minutes

/** Map of "previousState:newState" → anomaly definition. Only anomalous transitions are listed. */
const ANOMALOUS_TRANSITIONS: Record<string, { reason: string; logLevel: 'warn' | 'info'; message: string }> = {
  'running:offline':   { reason: 'crash',               logLevel: 'warn', message: 'Server crash detected' },
  'running:unknown':   { reason: 'crash',               logLevel: 'warn', message: 'Server crash detected (state unknown)' },
  'starting:offline':  { reason: 'startup-crash',       logLevel: 'warn', message: 'Server crashed during startup' },
  'starting:unknown':  { reason: 'startup-lost',        logLevel: 'warn', message: 'Server lost during startup' },
  'running:starting':  { reason: 'unexpected-restart',  logLevel: 'warn', message: 'Server restarted unexpectedly (skipped stopping)' },
  'stopping:starting': { reason: 'restart-during-stop', logLevel: 'info', message: 'Server restarted during shutdown' },
  'stopping:unknown':  { reason: 'stop-lost',           logLevel: 'warn', message: 'Server lost during shutdown' },
};

class PterodactylWsManager {
  // All Maps/Sets keyed by serverId (Pterodactyl ID, unique per instance)
  private readonly connections = new Map<string, WebSocket>();
  private readonly statsCache = new Map<string, PterodactylStats>();
  private readonly statusCache = new Map<string, string>();
  private readonly serverLookup = new Map<string, ServerEntry>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly stuckTimers = new Map<string, NodeJS.Timeout>();
  private readonly crashTimestamps = new Map<string, number[]>();
  private readonly crashLoopFlags = new Set<string>();
  private readonly crashLoopCooldowns = new Map<string, NodeJS.Timeout>();
  private readonly consoleCrashFlags = new Set<string>();
  private readonly pterodactyl = new PterodactylClient();
  private shuttingDown = false;

  // Tag grouping: tracks which tags have multiple instances for instanceKey computation
  private tagGroups = new Map<string, string[]>(); // tag → serverId[]

  async connect(): Promise<void> {
    const repo = new ServersRepository();
    const servers = await repo.findAllForSync();

    logger.info({ count: servers.length }, 'Connecting to Pterodactyl WebSockets');

    this.rebuildTagGroups(servers);

    for (const server of servers) {
      this.serverLookup.set(server.serverId, {
        serverId: server.serverId,
        tag: server.tag,
        name: server.name,
        serverOid: server._id,
      });
      await this.connectServer(server.serverId);
    }
  }

  async refresh(): Promise<void> {
    const repo = new ServersRepository();
    const servers = await repo.findAllForSync();
    const currentIds = new Set(this.serverLookup.keys());
    const newIds = new Set(servers.map((s) => s.serverId));

    this.rebuildTagGroups(servers);

    for (const server of servers) {
      if (!currentIds.has(server.serverId)) {
        logger.info({ tag: server.tag, serverId: server.serverId }, 'New server detected, connecting');
        this.serverLookup.set(server.serverId, {
          serverId: server.serverId,
          tag: server.tag,
          name: server.name,
          serverOid: server._id,
        });
        await this.connectServer(server.serverId);
      } else {
        this.serverLookup.set(server.serverId, {
          serverId: server.serverId,
          tag: server.tag,
          name: server.name,
          serverOid: server._id,
        });
        if (!this.connections.has(server.serverId)) {
          logger.info({ tag: server.tag, serverId: server.serverId }, 'Dead connection detected, reconnecting');
          await this.connectServer(server.serverId);
        }
      }
    }

    for (const id of currentIds) {
      if (!newIds.has(id)) {
        const entry = this.serverLookup.get(id);
        logger.info({ tag: entry?.tag, serverId: id }, 'Server removed, disconnecting');
        this.disconnectServer(id);
      }
    }
  }

  disconnect(): void {
    this.shuttingDown = true;
    for (const timer of this.stuckTimers.values()) clearTimeout(timer);
    this.stuckTimers.clear();
    for (const timer of this.crashLoopCooldowns.values()) clearTimeout(timer);
    this.crashLoopCooldowns.clear();
    this.crashLoopFlags.clear();
    this.crashTimestamps.clear();
    this.consoleCrashFlags.clear();
    for (const id of [...this.connections.keys()]) {
      this.disconnectServer(id);
    }
    logger.info('All Pterodactyl WebSocket connections closed');
  }

  /** Get stats for a tag (returns first matching instance). */
  getStats(tag: string): PterodactylStats | null {
    const ids = this.tagGroups.get(tag);
    if (!ids) return null;
    for (const id of ids) {
      const stats = this.statsCache.get(id);
      if (stats) return stats;
    }
    return null;
  }

  /** Get stats for a specific Pterodactyl server instance. */
  getStatsByServerId(serverId: string): PterodactylStats | null {
    return this.statsCache.get(serverId) ?? null;
  }

  /** Get per-instance stats/status for all instances under a tag. */
  getInstanceStatsByTag(tag: string): Map<string, { name: string; serverId: string; stats: PterodactylStats | null; status: string | null }> {
    const result = new Map<string, { name: string; serverId: string; stats: PterodactylStats | null; status: string | null }>();
    const ids = this.tagGroups.get(tag) ?? [];
    for (const id of ids) {
      const entry = this.serverLookup.get(id);
      if (!entry) continue;
      result.set(id, {
        name: entry.name,
        serverId: id,
        stats: this.statsCache.get(id) ?? null,
        status: this.statusCache.get(id) ?? null,
      });
    }
    return result;
  }

  getAllStats(): Map<string, PterodactylStats> {
    return this.statsCache;
  }

  getStatus(tag: string): string | null {
    const ids = this.tagGroups.get(tag);
    if (!ids) return null;
    for (const id of ids) {
      const status = this.statusCache.get(id);
      if (status) return status;
    }
    return null;
  }

  getStatusByServerId(serverId: string): string | null {
    return this.statusCache.get(serverId) ?? null;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private rebuildTagGroups(servers: Array<{ tag: string; serverId: string }>): void {
    this.tagGroups.clear();
    for (const s of servers) {
      const list = this.tagGroups.get(s.tag);
      if (list) list.push(s.serverId);
      else this.tagGroups.set(s.tag, [s.serverId]);
    }
  }

  /** Compute the instanceKey for stats recording. Single-instance tags use the tag; grouped use tag:serverId. */
  private instanceKey(entry: ServerEntry): string {
    const group = this.tagGroups.get(entry.tag);
    if (group && group.length > 1) return `${entry.tag}:${entry.serverId}`;
    return entry.tag;
  }

  private disconnectServer(serverId: string): void {
    const ws = this.connections.get(serverId);
    if (ws) {
      ws.removeAllListeners();
      ws.close();
      this.connections.delete(serverId);
    }
    this.clearStuckTimer(serverId);
    const cooldown = this.crashLoopCooldowns.get(serverId);
    if (cooldown) clearTimeout(cooldown);
    this.crashLoopCooldowns.delete(serverId);
    this.crashLoopFlags.delete(serverId);
    this.crashTimestamps.delete(serverId);
    this.consoleCrashFlags.delete(serverId);
    this.statsCache.delete(serverId);
    this.statusCache.delete(serverId);
    this.serverLookup.delete(serverId);
    this.reconnectAttempts.delete(serverId);
  }

  private clearStuckTimer(serverId: string): void {
    const timer = this.stuckTimers.get(serverId);
    if (timer) {
      clearTimeout(timer);
      this.stuckTimers.delete(serverId);
    }
  }

  private recordCrash(serverId: string, entry: ServerEntry): void {
    const now = Date.now();
    const timestamps = this.crashTimestamps.get(serverId) ?? [];
    timestamps.push(now);
    const cutoff = now - CRASH_LOOP_WINDOW_MS;
    const recent = timestamps.filter((t) => t > cutoff);
    this.crashTimestamps.set(serverId, recent);

    const cooldown = this.crashLoopCooldowns.get(serverId);
    if (cooldown) {
      clearTimeout(cooldown);
      this.crashLoopCooldowns.delete(serverId);
    }

    if (recent.length >= CRASH_LOOP_THRESHOLD && !this.crashLoopFlags.has(serverId)) {
      this.crashLoopFlags.add(serverId);
      logger.warn({ tag: entry.tag, serverId, name: entry.name, crashCount: recent.length }, 'Crash loop detected');
      eventBus.emit('server.crash-loop.started', {
        server: entry.tag,
        serverName: entry.name,
        crashCount: recent.length,
        serverId,
      });
    }
  }

  private handleRecoveryCrashLoop(serverId: string, entry: ServerEntry): void {
    if (!this.crashLoopFlags.has(serverId)) return;

    this.crashLoopCooldowns.set(serverId, setTimeout(() => {
      this.crashLoopCooldowns.delete(serverId);
      if (!this.crashLoopFlags.has(serverId)) return;
      this.crashLoopFlags.delete(serverId);
      this.crashTimestamps.delete(serverId);
      logger.info({ tag: entry.tag, serverId, name: entry.name }, 'Crash loop ended');
      eventBus.emit('server.crash-loop.ended', {
        server: entry.tag,
        serverName: entry.name,
        serverId,
      });
    }, CRASH_LOOP_WINDOW_MS));
  }

  private async connectServer(serverId: string): Promise<void> {
    try {
      const credentials = await this.pterodactyl.getWsCredentials(serverId);
      this.openConnection(serverId, credentials.token, credentials.socket);
    } catch (err) {
      const entry = this.serverLookup.get(serverId);
      logger.error({ err, tag: entry?.tag, serverId }, 'Failed to get WS credentials');
    }
  }

  private openConnection(serverId: string, token: string, socketUrl: string): void {
    const existing = this.connections.get(serverId);
    if (existing && existing.readyState !== WebSocket.CLOSED) {
      existing.removeAllListeners();
      existing.close();
    }

    const ws = new WebSocket(socketUrl, { origin: this.pterodactyl['baseUrl'] });
    this.connections.set(serverId, ws);

    const entry = this.serverLookup.get(serverId);
    const wsLogger = logger.child({ component: 'ptero-ws', tag: entry?.tag, serverId });

    ws.on('open', () => {
      wsLogger.info('Connected, authenticating');
      this.reconnectAttempts.set(serverId, 0);
      ws.send(JSON.stringify({ event: 'auth', args: [token] }));
    });

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as PterodactylWsEvent;
        this.handleEvent(serverId, msg);
      } catch {
        wsLogger.warn('Failed to parse WS message');
      }
    });

    ws.on('close', (code: number) => {
      wsLogger.info({ code }, 'Connection closed');
      this.connections.delete(serverId);

      if (this.shuttingDown) return;

      if (code === 4004 || code === 4001) {
        wsLogger.info('Token expired, reconnecting with fresh credentials');
        void this.connectServer(serverId);
        return;
      }

      if (code === 1006 || code !== 1000) {
        this.scheduleReconnect(serverId);
      }
    });

    ws.on('error', (err: Error) => {
      wsLogger.error({ err: err.message }, 'WebSocket error');
    });
  }

  private handleEvent(serverId: string, msg: PterodactylWsEvent): void {
    const entry = this.serverLookup.get(serverId);
    if (!entry) return;

    switch (msg.event) {
      case 'stats': {
        if (!msg.args?.[0]) break;
        const stats = JSON.parse(msg.args[0]) as PterodactylStats;
        this.statsCache.set(serverId, stats);
        eventBus.emit('server.stats', {
          server: entry.tag,
          serverOid: entry.serverOid,
          stats,
          serverId: entry.serverId,
          instanceKey: this.instanceKey(entry),
        });
        break;
      }

      case 'status': {
        if (!msg.args?.[0]) break;
        const newState = msg.args[0];
        const previousState = this.statusCache.get(serverId) ?? 'unknown';
        this.statusCache.set(serverId, newState);

        if (previousState === newState) break;

        this.clearStuckTimer(serverId);

        eventBus.emit('server.state.changed', {
          server: entry.tag,
          serverName: entry.name,
          previousState,
          currentState: newState,
          serverId: entry.serverId,
        });

        const anomaly = ANOMALOUS_TRANSITIONS[`${previousState}:${newState}`];
        if (anomaly) {
          if (this.consoleCrashFlags.has(serverId)) {
            this.consoleCrashFlags.delete(serverId);
          } else {
            logger[anomaly.logLevel]({ tag: entry.tag, serverId, name: entry.name, previousState, newState, reason: anomaly.reason }, anomaly.message);
            eventBus.emit('server.crashed', {
              server: entry.tag,
              serverName: entry.name,
              previousState,
              currentState: newState,
              reason: anomaly.reason,
              serverId: entry.serverId,
            });
            this.recordCrash(serverId, entry);
          }
        }

        if ((previousState === 'offline' || previousState === 'unknown') && newState === 'running') {
          this.consoleCrashFlags.delete(serverId);
          logger.info({ tag: entry.tag, serverId, name: entry.name }, 'Server recovered');
          eventBus.emit('server.recovered', {
            server: entry.tag,
            serverName: entry.name,
            serverId: entry.serverId,
          });
          this.handleRecoveryCrashLoop(serverId, entry);
        }

        if (newState === 'starting' || newState === 'stopping') {
          const timeout = newState === 'starting' ? STUCK_STARTING_TIMEOUT_MS : STUCK_STOPPING_TIMEOUT_MS;
          const reason = newState === 'starting' ? 'stuck-starting' : 'stuck-stopping';
          this.stuckTimers.set(serverId, setTimeout(() => {
            this.stuckTimers.delete(serverId);
            if (this.statusCache.get(serverId) !== newState) return;
            logger.warn({ tag: entry.tag, serverId, name: entry.name, state: newState }, `Server stuck ${newState}`);
            eventBus.emit('server.crashed', {
              server: entry.tag,
              serverName: entry.name,
              previousState: newState,
              currentState: newState,
              reason,
              serverId: entry.serverId,
            });
            this.recordCrash(serverId, entry);
          }, timeout));
        }
        break;
      }

      case 'console output': {
        if (!msg.args?.[0]) break;
        const line = msg.args[0];

        // eslint-disable-next-line no-control-regex
        const cleanLine = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

        if (
          cleanLine.includes('Considering it to be crashed, server will forcibly shutdown.') ||
          cleanLine.includes('---- Minecraft Crash Report ----')
        ) {
          const currentState = this.statusCache.get(serverId) ?? 'unknown';
          logger.warn({ tag: entry.tag, serverId, name: entry.name, currentState }, 'Crash detected from console output');
          this.consoleCrashFlags.add(serverId);
          eventBus.emit('server.crashed', {
            server: entry.tag,
            serverName: entry.name,
            previousState: currentState,
            currentState,
            reason: 'console-crash',
            serverId: entry.serverId,
          });
          this.recordCrash(serverId, entry);
        }

        eventBus.emit('server.console.output', { server: entry.tag, line, serverId: entry.serverId });
        break;
      }

      case 'jwt error': {
        logger.warn({ tag: entry.tag, serverId, error: msg.args?.[0] }, 'JWT error, reconnecting');
        void this.connectServer(serverId);
        break;
      }

      case 'token expiring': {
        logger.debug({ tag: entry.tag, serverId }, 'Token expiring, refreshing');
        void this.refreshToken(serverId);
        break;
      }

      case 'token expired': {
        void this.connectServer(serverId);
        break;
      }
    }
  }

  private async refreshToken(serverId: string): Promise<void> {
    try {
      const credentials = await this.pterodactyl.getWsCredentials(serverId);
      const ws = this.connections.get(serverId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'auth', args: [credentials.token] }));
        logger.debug({ serverId }, 'Token refreshed inline');
      }
    } catch (err) {
      logger.error({ err, serverId }, 'Failed to refresh token, reconnecting');
      void this.connectServer(serverId);
    }
  }

  private scheduleReconnect(serverId: string): void {
    const attempts = this.reconnectAttempts.get(serverId) ?? 0;
    if (attempts >= MAX_RECONNECT_ATTEMPTS) {
      const entry = this.serverLookup.get(serverId);
      logger.error({ tag: entry?.tag, serverId, attempts }, 'Max reconnect attempts reached, giving up');
      this.reconnectAttempts.delete(serverId);
      return;
    }

    const delay = BASE_RECONNECT_DELAY_MS * Math.pow(2, attempts);
    this.reconnectAttempts.set(serverId, attempts + 1);
    const entry = this.serverLookup.get(serverId);
    logger.info({ tag: entry?.tag, serverId, attempt: attempts + 1, delayMs: delay }, 'Scheduling reconnect');

    setTimeout(() => {
      if (this.shuttingDown || !this.serverLookup.has(serverId)) return;
      void this.connectServer(serverId);
    }, delay);
  }
}

export const pterodactylWsManager = new PterodactylWsManager();
