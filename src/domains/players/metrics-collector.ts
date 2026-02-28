import { config } from '../../config/index.js';
import { logger } from '../../core/logger/index.js';
import { eventBus } from '../../core/event-bus/index.js';
import { parsePlayerMetrics, type PlayerLatency } from '../../shared/utils/prometheus.js';
import type { OnlinePlayerDto, PlayerMetrics } from './players.types.js';

const POLL_INTERVAL_MS = 5_000;

interface CachedPlayer {
  username: string;
  server: string;
  latency: PlayerLatency;
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
      list.push({
        username: player.username,
        server: player.server,
        latencyP95: player.latency.latencyP95,
        latencyAvg: player.latency.latencyAvg,
        latencyMin: player.latency.latencyMin,
        latencyMax: player.latency.latencyMax,
      });
    }
    return grouped;
  }

  getOnlinePlayersList(): OnlinePlayerDto[] {
    return Array.from(this.cache.values()).map((p) => ({
      username: p.username,
      server: p.server,
      latencyP95: p.latency.latencyP95,
      latencyAvg: p.latency.latencyAvg,
      latencyMin: p.latency.latencyMin,
      latencyMax: p.latency.latencyMax,
    }));
  }

  isOnline(username: string): boolean {
    return this.cache.has(username);
  }

  getPlayerInfo(username: string): { server: string; latency: PlayerMetrics } | undefined {
    const player = this.cache.get(username);
    if (!player) return undefined;
    return { server: player.server, latency: player.latency };
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

      // Build new player map: username → { server, latency }
      const newPlayers = new Map<string, CachedPlayer>();
      for (const [server, players] of metrics.players) {
        for (const username of players) {
          const latency = metrics.latency.get(username) ?? { latencyP95: 0, latencyAvg: 0, latencyMin: 0, latencyMax: 0 };
          newPlayers.set(username, { username, server, latency });
        }
      }

      // Detect joins, leaves, and server changes
      for (const [username, newInfo] of newPlayers) {
        const oldInfo = this.cache.get(username);
        if (!oldInfo) {
          eventBus.emit('player.joined', { username, server: newInfo.server, latencyP95: newInfo.latency.latencyP95 });
        } else if (oldInfo.server !== newInfo.server) {
          eventBus.emit('player.server.changed', { username, previousServer: oldInfo.server, currentServer: newInfo.server });
        }
      }

      for (const [username, oldInfo] of this.cache) {
        if (!newPlayers.has(username)) {
          eventBus.emit('player.left', { username, server: oldInfo.server });
        }
      }

      this.cache = newPlayers;

      // Emit full list update
      const servers: Record<string, Array<{ username: string; latencyP95: number; latencyAvg: number; latencyMin: number; latencyMax: number }>> = {};
      for (const [username, info] of newPlayers) {
        let list = servers[info.server];
        if (!list) {
          list = [];
          servers[info.server] = list;
        }
        list.push({
          username,
          latencyP95: info.latency.latencyP95,
          latencyAvg: info.latency.latencyAvg,
          latencyMin: info.latency.latencyMin,
          latencyMax: info.latency.latencyMax,
        });
      }

      eventBus.emit('player.list.updated', { servers, count: newPlayers.size });
    } catch (err) {
      logger.error({ err }, 'Failed to poll player metrics');
    }
  }
}

export const metricsCollector = new MetricsCollector();
