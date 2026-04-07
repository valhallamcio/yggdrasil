import type { Collection, ObjectId, WithId } from 'mongodb';
import { getClient, getDb } from '../../core/database/client.js';
import type { ServerDocument, ShardDocument, StatsHistoryDocument } from './servers.types.js';

const DB_NAME = 'bifrost';

const HOUR = 3_600_000;

function pickBucket(rangeMs: number): { unit: 'minute' | 'hour' | 'day'; binSize: number } | null {
  const hours = rangeMs / HOUR;
  if (hours <= 2) return null;            // raw
  if (hours <= 12) return { unit: 'minute', binSize: 5 };
  if (hours <= 48) return { unit: 'minute', binSize: 15 };
  if (hours <= 168) return { unit: 'hour', binSize: 1 };
  if (hours <= 720) return { unit: 'hour', binSize: 4 };
  if (hours <= 2160) return { unit: 'hour', binSize: 12 };
  return { unit: 'day', binSize: 1 };
}

export class ServersRepository {
  private _servers?: Collection<ServerDocument>;
  private _shards?: Collection<ShardDocument>;
  private _history?: Collection<StatsHistoryDocument>;

  private get servers(): Collection<ServerDocument> {
    this._servers ??= getClient().db(DB_NAME).collection<ServerDocument>('servers');
    return this._servers;
  }

  private get shards(): Collection<ShardDocument> {
    this._shards ??= getClient().db(DB_NAME).collection<ShardDocument>('shards');
    return this._shards;
  }

  get history(): Collection<StatsHistoryDocument> {
    this._history ??= getDb().collection<StatsHistoryDocument>('server_stats_history');
    return this._history;
  }

  // ── Servers ──────────────────────────────────────────────────────────────

  async findAll(): Promise<WithId<ServerDocument>[]> {
    return this.servers.find({}).toArray();
  }

  async findByTag(tag: string): Promise<WithId<ServerDocument> | null> {
    return this.servers.findOne({ tag });
  }

  async updateByTag(tag: string, fields: Record<string, unknown>): Promise<boolean> {
    const result = await this.servers.updateOne({ tag }, { $set: fields });
    return result.matchedCount > 0;
  }

  async findAllForSync(): Promise<Array<{ _id: ObjectId; tag: string; serverId: string; name: string }>> {
    return this.servers
      .find({}, { projection: { _id: 1, tag: 1, serverId: 1, name: 1 } })
      .toArray() as Promise<Array<{ _id: ObjectId; tag: string; serverId: string; name: string }>>;
  }

  // ── Shards ───────────────────────────────────────────────────────────────

  async findShardByServerRef(serverOid: ObjectId): Promise<WithId<ShardDocument> | null> {
    return this.shards.findOne({ server: serverOid });
  }

  async findAllShards(): Promise<WithId<ShardDocument>[]> {
    return this.shards.find({}).toArray();
  }

  // ── Stats History ────────────────────────────────────────────────────────

  async findStatsHistory(tag: string, from: Date, to: Date): Promise<StatsHistoryDocument[]> {
    const bucket = pickBucket(to.getTime() - from.getTime());

    if (!bucket) {
      return this.history
        .find({ server: tag, timestamp: { $gte: from, $lte: to } })
        .sort({ timestamp: 1 })
        .toArray();
    }

    return this.history
      .aggregate<StatsHistoryDocument>([
        { $match: { server: tag, timestamp: { $gte: from, $lte: to } } },
        { $sort: { timestamp: 1 } },
        {
          $group: {
            _id: { $dateTrunc: { date: '$timestamp', unit: bucket.unit, binSize: bucket.binSize } },
            server: { $first: '$server' },
            status: { $last: '$status' },
            cpu: { $avg: '$cpu' },
            memoryBytes: { $avg: '$memoryBytes' },
            memoryLimitBytes: { $max: '$memoryLimitBytes' },
            diskBytes: { $avg: '$diskBytes' },
            networkRxBytes: { $max: '$networkRxBytes' },
            networkTxBytes: { $max: '$networkTxBytes' },
            uptime: { $max: '$uptime' },
            tps: { $avg: '$tps' },
            players: { $max: '$players' },
          },
        },
        { $sort: { _id: 1 } },
        {
          $project: {
            _id: 0,
            timestamp: '$_id',
            server: 1,
            status: 1,
            cpu: { $round: ['$cpu', 2] },
            memoryBytes: { $round: ['$memoryBytes', 0] },
            memoryLimitBytes: 1,
            diskBytes: { $round: ['$diskBytes', 0] },
            networkRxBytes: 1,
            networkTxBytes: 1,
            uptime: 1,
            tps: { $round: ['$tps', 2] },
            players: 1,
          },
        },
      ])
      .toArray();
  }
}
