import type { Collection, ObjectId, WithId } from 'mongodb';
import { getClient, getDb } from '../../core/database/client.js';
import type { ServerDocument, ShardDocument, StatsHistoryDocument } from './servers.types.js';

const DB_NAME = 'valhallamc';

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
    return this.history
      .find({ server: tag, timestamp: { $gte: from, $lte: to } })
      .sort({ timestamp: 1 })
      .toArray();
  }
}
