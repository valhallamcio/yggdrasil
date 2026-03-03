import { BaseRepository } from '../../repositories/base.repository.js';
import type { ServerRegistryDocument } from './servers.types.js';

export class ServerRegistryRepository extends BaseRepository<ServerRegistryDocument> {
  constructor() {
    super('server_registry');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ tag: 1 }, { unique: true });
  }

  async upsertFromSource(data: {
    tag: string;
    name: string;
    desc: string;
    color: string;
    image: string;
    genre: string;
    platform: string;
    serverVersion: string;
    modpackVersion: string;
    earlyAccess: boolean;
  }): Promise<void> {
    const now = new Date();
    await this.collection.updateOne(
      { tag: data.tag },
      {
        $set: {
          name: data.name,
          desc: data.desc,
          color: data.color,
          image: data.image,
          genre: data.genre,
          platform: data.platform,
          serverVersion: data.serverVersion,
          modpackVersion: data.modpackVersion,
          earlyAccess: data.earlyAccess,
          active: true,
          lastSeenAt: now,
          updatedAt: now,
        },
        $setOnInsert: {
          tag: data.tag,
          createdAt: now,
        },
      },
      { upsert: true },
    );
  }

  async deactivateMissing(activeTags: Set<string>): Promise<number> {
    const result = await this.collection.updateMany(
      { active: true, tag: { $nin: [...activeTags] } },
      { $set: { active: false, updatedAt: new Date() } },
    );
    return result.modifiedCount;
  }

  async findByTag(tag: string): Promise<ServerRegistryDocument | null> {
    return this.findOne({ tag });
  }

  async findAllEntries(): Promise<ServerRegistryDocument[]> {
    return this.findMany({});
  }
}
