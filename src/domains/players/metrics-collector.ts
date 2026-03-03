import { config } from '../../config/index.js';
import { logger } from '../../core/logger/index.js';
import { eventBus } from '../../core/event-bus/index.js';
import { parsePlayerMetrics } from '../../shared/utils/prometheus.js';
import type { OnlinePlayerDto } from './players.types.js';

const POLL_INTERVAL_MS = 5_000;

interface CachedPlayer {
  username: string;
  server: string;
  ping: number;
}

class MetricsCollector {
  private interval: ReturnType<typeof setInterval> | null = null;
  private cache = new Map<string, CachedPlayer>();
  private running = false;

  async start(): Promise<void> {
    if (!config.VELOCITY_METRICS_URL) {
      logger.warn('VELOCITY_METRICS_URL not configured — player metrics collector disabled');
      return;
    }

    this.running = true;
    // Initial poll immediately
    await this.poll();
    this.interval = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    logger.info({ url: config.VELOCITY_METRICS_URL, intervalMs: POLL_INTERVAL_MS }, 'Player metrics collector started');
  }

  stop(): void {
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    logger.info('Player metrics collector stopped');
  }

  getOnlinePlayers(): Record<string, OnlinePlayerDto[]> {
    const grouped: Record<string, OnlinePlayerDto[]> = {};
    for (const player of this.cache.values()) {
      let list = grouped[player.server];
      if (!list) {
        list = [];
        grouped[player.server] = list;
      }
      list.push({ username: player.username, server: player.server, ping: player.ping });
    }
    return grouped;
  }

  getOnlinePlayersList(): OnlinePlayerDto[] {
    return Array.from(this.cache.values()).map((p) => ({
      username: p.username,
      server: p.server,
      ping: p.ping,
    }));
  }

  isOnline(username: string): boolean {
    return this.cache.has(username);
  }

  getPlayerInfo(username: string): { server: string; ping: number } | undefined {
    const player = this.cache.get(username);
    if (!player) return undefined;
    return { server: player.server, ping: player.ping };
  }

  get count(): number {
    return this.cache.size;
  }

  private async poll(): Promise<void> {
    if (!this.running || !config.VELOCITY_METRICS_URL) return;

    try {
      const res = await fetch(config.VELOCITY_METRICS_URL, {
        signal: AbortSignal.timeout(4_000),
      });
      if (!res.ok) {
        logger.warn({ status: res.status }, 'Metrics endpoint returned non-OK status');
        return;
      }

      const text = await res.text();
      const metrics = parsePlayerMetrics(text);

      // Build new player map: username → { server, ping }
      const newPlayers = new Map<string, CachedPlayer>();
      for (const [server, players] of metrics.players) {
        for (const username of players) {
          const latency = metrics.latency.get(username);
          // Use P95 as the representative ping value
          const ping = latency?.latencyP95 ?? 0;
          newPlayers.set(username, { username, server, ping });
        }
      }

      // Detect joins, leaves, and server changes
      for (const [username, newInfo] of newPlayers) {
        const oldInfo = this.cache.get(username);
        if (!oldInfo) {
          eventBus.emit('player.joined', { username, uuid: '', ip: '', server: newInfo.server, ping: newInfo.ping });
        } else if (oldInfo.server !== newInfo.server) {
          eventBus.emit('player.server.changed', { username, uuid: '', ip: '', previousServer: oldInfo.server, currentServer: newInfo.server });
        }
      }

      for (const [username, oldInfo] of this.cache) {
        if (!newPlayers.has(username)) {
          eventBus.emit('player.left', { username, uuid: '', ip: '', server: oldInfo.server });
        }
      }

      this.cache = newPlayers;

      // Emit full list update
      const servers: Record<string, Array<{ username: string; ping: number }>> = {};
      for (const [username, info] of newPlayers) {
        let list = servers[info.server];
        if (!list) {
          list = [];
          servers[info.server] = list;
        }
        list.push({ username, ping: info.ping });
      }

      eventBus.emit('player.list.updated', { servers, count: newPlayers.size });
    } catch (err) {
      logger.error({ err }, 'Failed to poll player metrics');
    }
  }
}

export const metricsCollector = new MetricsCollector();
