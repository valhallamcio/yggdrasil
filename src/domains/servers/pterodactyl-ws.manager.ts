import WebSocket from 'ws';
import { logger } from '../../core/logger/index.js';
import { eventBus } from '../../core/event-bus/index.js';
import { PterodactylClient } from './pterodactyl.client.js';
import { ServersRepository } from './servers.repository.js';
import type { PterodactylStats } from './servers.types.js';
import type { ObjectId } from 'mongodb';

interface ServerEntry {
  serverId: string;
  name: string;
  serverOid: ObjectId;
}

interface PterodactylWsEvent {
  event: string;
  args?: string[];
}

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 1_000;

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
  private readonly connections = new Map<string, WebSocket>();
  private readonly statsCache = new Map<string, PterodactylStats>();
  private readonly statusCache = new Map<string, string>();
  private readonly serverLookup = new Map<string, ServerEntry>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly pterodactyl = new PterodactylClient();
  private shuttingDown = false;

  async connect(): Promise<void> {
    const repo = new ServersRepository();
    const servers = await repo.findAllForSync();

    logger.info({ count: servers.length }, 'Connecting to Pterodactyl WebSockets');

    for (const server of servers) {
      this.serverLookup.set(server.tag, {
        serverId: server.serverId,
        name: server.name,
        serverOid: server._id,
      });
      await this.connectServer(server.tag, server.serverId);
    }
  }

  async refresh(): Promise<void> {
    const repo = new ServersRepository();
    const servers = await repo.findAllForSync();
    const currentTags = new Set(this.serverLookup.keys());
    const newTags = new Set(servers.map((s) => s.tag));

    // Connect to new servers
    for (const server of servers) {
      if (!currentTags.has(server.tag)) {
        logger.info({ tag: server.tag }, 'New server detected, connecting');
        this.serverLookup.set(server.tag, {
          serverId: server.serverId,
          name: server.name,
          serverOid: server._id,
        });
        await this.connectServer(server.tag, server.serverId);
      } else {
        // Update metadata for existing servers
        this.serverLookup.set(server.tag, {
          serverId: server.serverId,
          name: server.name,
          serverOid: server._id,
        });
      }
    }

    // Disconnect removed servers
    for (const tag of currentTags) {
      if (!newTags.has(tag)) {
        logger.info({ tag }, 'Server removed, disconnecting');
        this.disconnectServer(tag);
      }
    }
  }

  disconnect(): void {
    this.shuttingDown = true;
    for (const tag of [...this.connections.keys()]) {
      this.disconnectServer(tag);
    }
    logger.info('All Pterodactyl WebSocket connections closed');
  }

  getStats(tag: string): PterodactylStats | null {
    return this.statsCache.get(tag) ?? null;
  }

  getAllStats(): Map<string, PterodactylStats> {
    return this.statsCache;
  }

  getStatus(tag: string): string | null {
    return this.statusCache.get(tag) ?? null;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private disconnectServer(tag: string): void {
    const ws = this.connections.get(tag);
    if (ws) {
      ws.removeAllListeners();
      ws.close();
      this.connections.delete(tag);
    }
    this.statsCache.delete(tag);
    this.statusCache.delete(tag);
    this.serverLookup.delete(tag);
    this.reconnectAttempts.delete(tag);
  }

  private async connectServer(tag: string, serverId: string): Promise<void> {
    try {
      const credentials = await this.pterodactyl.getWsCredentials(serverId);
      this.openConnection(tag, serverId, credentials.token, credentials.socket);
    } catch (err) {
      logger.error({ err, tag, serverId }, 'Failed to get WS credentials');
    }
  }

  private openConnection(tag: string, serverId: string, token: string, socketUrl: string): void {
    // Close existing connection if any
    const existing = this.connections.get(tag);
    if (existing && existing.readyState !== WebSocket.CLOSED) {
      existing.removeAllListeners();
      existing.close();
    }

    const ws = new WebSocket(socketUrl, { origin: this.pterodactyl['baseUrl'] });
    this.connections.set(tag, ws);

    const wsLogger = logger.child({ component: 'ptero-ws', tag });

    ws.on('open', () => {
      wsLogger.info('Connected, authenticating');
      this.reconnectAttempts.set(tag, 0);
      ws.send(JSON.stringify({ event: 'auth', args: [token] }));
    });

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as PterodactylWsEvent;
        this.handleEvent(tag, msg);
      } catch {
        wsLogger.warn('Failed to parse WS message');
      }
    });

    ws.on('close', (code: number) => {
      wsLogger.info({ code }, 'Connection closed');
      this.connections.delete(tag);

      if (this.shuttingDown) return;

      if (code === 4004 || code === 4001) {
        // Token expired or auth failed — reconnect with fresh token
        wsLogger.info('Token expired, reconnecting with fresh credentials');
        void this.connectServer(tag, serverId);
        return;
      }

      // Abnormal close — reconnect with backoff
      if (code === 1006 || code !== 1000) {
        this.scheduleReconnect(tag, serverId);
      }
    });

    ws.on('error', (err: Error) => {
      wsLogger.error({ err: err.message }, 'WebSocket error');
    });
  }

  private handleEvent(tag: string, msg: PterodactylWsEvent): void {
    const entry = this.serverLookup.get(tag);
    if (!entry) return;

    switch (msg.event) {
      case 'stats': {
        if (!msg.args?.[0]) break;
        const stats = JSON.parse(msg.args[0]) as PterodactylStats;
        this.statsCache.set(tag, stats);
        eventBus.emit('server.stats', { server: tag, stats });
        break;
      }

      case 'status': {
        if (!msg.args?.[0]) break;
        const newState = msg.args[0];
        const previousState = this.statusCache.get(tag) ?? 'unknown';
        this.statusCache.set(tag, newState);

        if (previousState === newState) break;

        eventBus.emit('server.state.changed', {
          server: tag,
          serverName: entry.name,
          previousState,
          currentState: newState,
        });

        // Anomaly detection (crashes, startup failures, unexpected restarts, etc.)
        const anomaly = ANOMALOUS_TRANSITIONS[`${previousState}:${newState}`];
        if (anomaly) {
          logger[anomaly.logLevel]({ tag, name: entry.name, previousState, newState, reason: anomaly.reason }, anomaly.message);
          eventBus.emit('server.crashed', {
            server: tag,
            serverName: entry.name,
            previousState,
            currentState: newState,
            reason: anomaly.reason,
          });
        }

        // Recovery: was offline/unknown, now running
        if ((previousState === 'offline' || previousState === 'unknown') && newState === 'running') {
          logger.info({ tag, name: entry.name }, 'Server recovered');
          eventBus.emit('server.recovered', {
            server: tag,
            serverName: entry.name,
          });
        }
        break;
      }

      case 'console output': {
        if (!msg.args?.[0]) break;
        eventBus.emit('server.console.output', {
          server: tag,
          line: msg.args[0],
        });
        break;
      }

      case 'jwt error': {
        logger.warn({ tag, error: msg.args?.[0] }, 'JWT error, reconnecting');
        const entry = this.serverLookup.get(tag);
        if (entry) void this.connectServer(tag, entry.serverId);
        break;
      }

      case 'token expiring': {
        // Some Pterodactyl versions send this before expiry
        const entry = this.serverLookup.get(tag);
        if (entry) {
          logger.debug({ tag }, 'Token expiring, refreshing');
          void this.refreshToken(tag, entry.serverId);
        }
        break;
      }

      case 'token expired': {
        const entry = this.serverLookup.get(tag);
        if (entry) void this.connectServer(tag, entry.serverId);
        break;
      }
    }
  }

  private async refreshToken(tag: string, serverId: string): Promise<void> {
    try {
      const credentials = await this.pterodactyl.getWsCredentials(serverId);
      const ws = this.connections.get(tag);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'auth', args: [credentials.token] }));
        logger.debug({ tag }, 'Token refreshed inline');
      }
    } catch (err) {
      logger.error({ err, tag }, 'Failed to refresh token, reconnecting');
      void this.connectServer(tag, serverId);
    }
  }

  private scheduleReconnect(tag: string, serverId: string): void {
    const attempts = this.reconnectAttempts.get(tag) ?? 0;
    if (attempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.error({ tag, attempts }, 'Max reconnect attempts reached, giving up');
      this.reconnectAttempts.delete(tag);
      return;
    }

    const delay = BASE_RECONNECT_DELAY_MS * Math.pow(2, attempts);
    this.reconnectAttempts.set(tag, attempts + 1);
    logger.info({ tag, attempt: attempts + 1, delayMs: delay }, 'Scheduling reconnect');

    setTimeout(() => {
      if (this.shuttingDown || !this.serverLookup.has(tag)) return;
      void this.connectServer(tag, serverId);
    }, delay);
  }
}

export const pterodactylWsManager = new PterodactylWsManager();
