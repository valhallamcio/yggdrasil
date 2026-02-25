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
    for (const timer of this.stuckTimers.values()) clearTimeout(timer);
    this.stuckTimers.clear();
    for (const timer of this.crashLoopCooldowns.values()) clearTimeout(timer);
    this.crashLoopCooldowns.clear();
    this.crashLoopFlags.clear();
    this.crashTimestamps.clear();
    this.consoleCrashFlags.clear();
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
    this.clearStuckTimer(tag);
    const cooldown = this.crashLoopCooldowns.get(tag);
    if (cooldown) clearTimeout(cooldown);
    this.crashLoopCooldowns.delete(tag);
    this.crashLoopFlags.delete(tag);
    this.crashTimestamps.delete(tag);
    this.consoleCrashFlags.delete(tag);
    this.statsCache.delete(tag);
    this.statusCache.delete(tag);
    this.serverLookup.delete(tag);
    this.reconnectAttempts.delete(tag);
  }

  private clearStuckTimer(tag: string): void {
    const timer = this.stuckTimers.get(tag);
    if (timer) {
      clearTimeout(timer);
      this.stuckTimers.delete(tag);
    }
  }

  private recordCrash(tag: string, entry: ServerEntry): void {
    const now = Date.now();
    const timestamps = this.crashTimestamps.get(tag) ?? [];
    timestamps.push(now);
    const cutoff = now - CRASH_LOOP_WINDOW_MS;
    const recent = timestamps.filter((t) => t > cutoff);
    this.crashTimestamps.set(tag, recent);

    // Cancel any cooldown timer (server crashed again, still in loop)
    const cooldown = this.crashLoopCooldowns.get(tag);
    if (cooldown) {
      clearTimeout(cooldown);
      this.crashLoopCooldowns.delete(tag);
    }

    if (recent.length >= CRASH_LOOP_THRESHOLD && !this.crashLoopFlags.has(tag)) {
      this.crashLoopFlags.add(tag);
      logger.warn({ tag, name: entry.name, crashCount: recent.length }, 'Crash loop detected');
      eventBus.emit('server.crash-loop.started', {
        server: tag,
        serverName: entry.name,
        crashCount: recent.length,
      });
    }
  }

  private handleRecoveryCrashLoop(tag: string, entry: ServerEntry): void {
    if (!this.crashLoopFlags.has(tag)) return;

    this.crashLoopCooldowns.set(tag, setTimeout(() => {
      this.crashLoopCooldowns.delete(tag);
      if (!this.crashLoopFlags.has(tag)) return;
      this.crashLoopFlags.delete(tag);
      this.crashTimestamps.delete(tag);
      logger.info({ tag, name: entry.name }, 'Crash loop ended');
      eventBus.emit('server.crash-loop.ended', {
        server: tag,
        serverName: entry.name,
      });
    }, CRASH_LOOP_WINDOW_MS));
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

        // Clear any stuck-state timer — the server transitioned
        this.clearStuckTimer(tag);

        eventBus.emit('server.state.changed', {
          server: tag,
          serverName: entry.name,
          previousState,
          currentState: newState,
        });

        // Anomaly detection (crashes, startup failures, unexpected restarts, etc.)
        const anomaly = ANOMALOUS_TRANSITIONS[`${previousState}:${newState}`];
        if (anomaly) {
          if (this.consoleCrashFlags.has(tag)) {
            // Console already detected this crash — skip duplicate emission
            this.consoleCrashFlags.delete(tag);
          } else {
            logger[anomaly.logLevel]({ tag, name: entry.name, previousState, newState, reason: anomaly.reason }, anomaly.message);
            eventBus.emit('server.crashed', {
              server: tag,
              serverName: entry.name,
              previousState,
              currentState: newState,
              reason: anomaly.reason,
            });
            this.recordCrash(tag, entry);
          }
        }

        // Recovery: was offline/unknown, now running
        if ((previousState === 'offline' || previousState === 'unknown') && newState === 'running') {
          this.consoleCrashFlags.delete(tag);
          logger.info({ tag, name: entry.name }, 'Server recovered');
          eventBus.emit('server.recovered', {
            server: tag,
            serverName: entry.name,
          });
          this.handleRecoveryCrashLoop(tag, entry);
        }

        // Stuck-state detection: start a timer if entering starting/stopping
        if (newState === 'starting' || newState === 'stopping') {
          const timeout = newState === 'starting' ? STUCK_STARTING_TIMEOUT_MS : STUCK_STOPPING_TIMEOUT_MS;
          const reason = newState === 'starting' ? 'stuck-starting' : 'stuck-stopping';
          this.stuckTimers.set(tag, setTimeout(() => {
            this.stuckTimers.delete(tag);
            if (this.statusCache.get(tag) !== newState) return;
            logger.warn({ tag, name: entry.name, state: newState }, `Server stuck ${newState}`);
            eventBus.emit('server.crashed', {
              server: tag,
              serverName: entry.name,
              previousState: newState,
              currentState: newState,
              reason,
            });
            this.recordCrash(tag, entry);
          }, timeout));
        }
        break;
      }

      case 'console output': {
        if (!msg.args?.[0]) break;
        const line = msg.args[0];

        // Strip ANSI escape codes for pattern matching (Pterodactyl relays raw console output)
        // eslint-disable-next-line no-control-regex
        const cleanLine = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

        // Crash detection via console output patterns
        if (
          cleanLine.includes('Considering it to be crashed, server will forcibly shutdown.') ||
          cleanLine.includes('---- Minecraft Crash Report ----')
        ) {
          const currentState = this.statusCache.get(tag) ?? 'unknown';
          logger.warn({ tag, name: entry.name, currentState }, 'Crash detected from console output');
          this.consoleCrashFlags.add(tag);
          eventBus.emit('server.crashed', {
            server: tag,
            serverName: entry.name,
            previousState: currentState,
            currentState,
            reason: 'console-crash',
          });
          this.recordCrash(tag, entry);
        }

        eventBus.emit('server.console.output', { server: tag, line });
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
