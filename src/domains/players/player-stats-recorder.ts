import { eventBus } from '../../core/event-bus/index.js';
import { getDb } from '../../core/database/client.js';
import { logger } from '../../core/logger/index.js';
import { PlayersRepository } from './players.repository.js';
import type { PlayerHistoryDocument } from './players.types.js';

const THROTTLE_MS = 60_000;

type PlayerPayload = {
  servers: Record<string, Array<{ username: string; latencyP95: number; latencyAvg: number; latencyMin: number; latencyMax: number }>>;
  count: number;
};

class PlayerStatsRecorder {
  private lastWrite = 0;
  private repo?: PlayersRepository;
  private listening = false;

  // Peak tracking between writes — updated every 5s, written & reset every 60s
  private peakGlobal = 0;
  private peakServers: Record<string, number> = {};
  private latestPayload: PlayerPayload | null = null;

  async start(): Promise<void> {
    const db = getDb();

    try {
      await db.createCollection('player_stats_history', {
        timeseries: {
          timeField: 'timestamp',
          metaField: 'source',
          granularity: 'minutes',
        },
      });
      logger.info('Created player_stats_history time series collection');
    } catch {
      try {
        await db.command({ collMod: 'player_stats_history', timeseries: { granularity: 'minutes' } });
        logger.info('Upgraded player_stats_history granularity to minutes');
      } catch {
        // Already at minutes or higher
      }
    }

    this.repo = new PlayersRepository();
    this.listening = true;
    eventBus.on('player.list.updated', this.onListUpdated);
    logger.info('Player stats recorder started');
  }

  stop(): void {
    this.listening = false;
    eventBus.off('player.list.updated', this.onListUpdated);
    logger.info('Player stats recorder stopped');
  }

  /** Returns the live (unwritten) snapshot for fresh-data injection in the history endpoint. */
  getCurrentSnapshot(): { global: { count: number; peakCount: number }; servers: Record<string, { count: number; peakCount: number }> } {
    const servers: Record<string, { count: number; peakCount: number }> = {};
    if (this.latestPayload) {
      for (const [tag, players] of Object.entries(this.latestPayload.servers)) {
        servers[tag] = { count: players.length, peakCount: this.peakServers[tag] ?? players.length };
      }
    }
    return {
      global: { count: this.latestPayload?.count ?? 0, peakCount: this.peakGlobal },
      servers,
    };
  }

  private onListUpdated = (payload: PlayerPayload): void => {
    if (!this.listening) return;

    this.latestPayload = payload;

    // Always update peaks (runs every 5s poll)
    this.peakGlobal = Math.max(this.peakGlobal, payload.count);
    for (const [server, players] of Object.entries(payload.servers)) {
      this.peakServers[server] = Math.max(this.peakServers[server] ?? 0, players.length);
    }

    // Throttle actual writes to 60s
    const now = Date.now();
    if (now - this.lastWrite < THROTTLE_MS) return;

    this.lastWrite = now;
    void this.record(payload);
  };

  private async record(payload: PlayerPayload): Promise<void> {
    try {
      const now = new Date();
      const docs: PlayerHistoryDocument[] = [];

      // Global document
      let totalP95 = 0;
      let totalAvg = 0;
      let playerCount = 0;

      for (const players of Object.values(payload.servers)) {
        for (const p of players) {
          totalP95 += p.latencyP95;
          totalAvg += p.latencyAvg;
          playerCount++;
        }
      }

      docs.push({
        timestamp: now,
        source: 'global',
        playerCount: payload.count,
        peakPlayerCount: this.peakGlobal,
        avgLatencyP95: playerCount > 0 ? Math.round((totalP95 / playerCount) * 100) / 100 : 0,
        avgLatencyAvg: playerCount > 0 ? Math.round((totalAvg / playerCount) * 100) / 100 : 0,
      });

      // Per-server documents
      for (const [server, players] of Object.entries(payload.servers)) {
        let serverP95 = 0;
        let serverAvg = 0;
        for (const p of players) {
          serverP95 += p.latencyP95;
          serverAvg += p.latencyAvg;
        }
        const count = players.length;
        docs.push({
          timestamp: now,
          source: server,
          playerCount: count,
          peakPlayerCount: this.peakServers[server] ?? count,
          avgLatencyP95: count > 0 ? Math.round((serverP95 / count) * 100) / 100 : 0,
          avgLatencyAvg: count > 0 ? Math.round((serverAvg / count) * 100) / 100 : 0,
        });
      }

      await this.repo!.history.insertMany(docs);

      // Reset peaks for next interval
      this.peakGlobal = 0;
      this.peakServers = {};
    } catch (err) {
      logger.error({ err }, 'Failed to record player stats history');
    }
  }
}

export const playerStatsRecorder = new PlayerStatsRecorder();
