import { eventBus } from '../../core/event-bus/index.js';
import { getDb } from '../../core/database/client.js';
import { logger } from '../../core/logger/index.js';
import { ServersRepository } from './servers.repository.js';
import type { StatsHistoryDocument } from './servers.types.js';
import type { ServerStatsPayload } from '../../core/event-bus/events.js';
const THROTTLE_MS = 30_000; // Write at most once every 30 seconds per server

class StatsRecorder {
  private readonly lastWrite = new Map<string, number>();
  private repo?: ServersRepository;
  private listening = false;

  async start(): Promise<void> {
    // Ensure time series collection exists
    try {
      await getDb().createCollection('server_stats_history', {
        timeseries: {
          timeField: 'timestamp',
          metaField: 'server',
          granularity: 'seconds',
        },
      });
      logger.info('Created server_stats_history time series collection');
    } catch {
      // Collection already exists — ignore
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

  private onStats = ({ server, stats }: { server: string; stats: ServerStatsPayload }): void => {
    if (!this.listening) return;

    const now = Date.now();
    const lastTime = this.lastWrite.get(server) ?? 0;
    if (now - lastTime < THROTTLE_MS) return;

    this.lastWrite.set(server, now);
    void this.record(server, stats);
  };

  private async record(tag: string, stats: ServerStatsPayload): Promise<void> {
    try {
      // Get shard data for TPS and players
      let tps = 0;
      let players = 0;

      if (this.repo) {
        const allShards = await this.repo.findAllShards();
        // Find the shard matching this server by cross-referencing
        const servers = await this.repo.findAllForSync();
        const serverDoc = servers.find((s) => s.tag === tag);
        if (serverDoc) {
          const shard = allShards.find((s) => s.server.equals(serverDoc._id));
          if (shard) {
            tps = shard.tps;
            players = shard.players;
          }
        }
      }

      const doc: StatsHistoryDocument = {
        timestamp: new Date(),
        server: tag,
        status: stats.state,
        cpu: stats.cpu_absolute,
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
