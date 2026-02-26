import type { ObjectId } from 'mongodb';
import { eventBus } from '../../core/event-bus/index.js';
import { getDb } from '../../core/database/client.js';
import { logger } from '../../core/logger/index.js';
import { ServersRepository } from './servers.repository.js';
import type { StatsHistoryDocument } from './servers.types.js';
import type { ServerStatsPayload } from '../../core/event-bus/events.js';

const THROTTLE_MS = 60_000; // Write at most once every 60 seconds per server

class StatsRecorder {
  private readonly lastWrite = new Map<string, number>();
  private repo?: ServersRepository;
  private listening = false;

  async start(): Promise<void> {
    const db = getDb();

    // Ensure time series collection exists
    try {
      await db.createCollection('server_stats_history', {
        timeseries: {
          timeField: 'timestamp',
          metaField: 'server',
          granularity: 'minutes',
        },
      });
      logger.info('Created server_stats_history time series collection');
    } catch {
      // Collection already exists — try to upgrade granularity
      try {
        await db.command({ collMod: 'server_stats_history', timeseries: { granularity: 'minutes' } });
        logger.info('Upgraded server_stats_history granularity to minutes');
      } catch {
        // Already at minutes or higher — ignore
      }
    }

    this.repo = new ServersRepository();
    this.listening = true;
    eventBus.on('server.stats', this.onStats);
    logger.info('Stats recorder started');
  }

  stop(): void {
    this.listening = false;
    eventBus.off('server.stats', this.onStats);
    logger.info('Stats recorder stopped');
  }

  private onStats = ({ server, serverOid, stats }: { server: string; serverOid: ObjectId; stats: ServerStatsPayload }): void => {
    if (!this.listening) return;

    const now = Date.now();
    const lastTime = this.lastWrite.get(server) ?? 0;
    if (now - lastTime < THROTTLE_MS) return;

    this.lastWrite.set(server, now);
    void this.record(server, serverOid, stats);
  };

  private async record(tag: string, serverOid: ObjectId, stats: ServerStatsPayload): Promise<void> {
    try {
      let tps = 0;
      let players = 0;

      if (this.repo) {
        const shard = await this.repo.findShardByServerRef(serverOid);
        if (shard) {
          tps = Math.round(shard.tps * 100) / 100;
          players = shard.players;
        }
      }

      const doc: StatsHistoryDocument = {
        timestamp: new Date(),
        server: tag,
        status: stats.state,
        cpu: Math.round(stats.cpu_absolute * 100) / 100,
        memoryBytes: stats.memory_bytes,
        memoryLimitBytes: stats.memory_limit_bytes,
        diskBytes: stats.disk_bytes,
        networkRxBytes: stats.network.rx_bytes,
        networkTxBytes: stats.network.tx_bytes,
        uptime: stats.uptime,
        tps,
        players,
      };

      await this.repo!.history.insertOne(doc);
    } catch (err) {
      logger.error({ err, tag }, 'Failed to record stats history');
    }
  }
}

export const statsRecorder = new StatsRecorder();
