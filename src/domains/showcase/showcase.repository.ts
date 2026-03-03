import { BaseRepository } from '../../repositories/base.repository.js';
import type { ShowcaseCacheDocument, ShowcasePost } from './showcase.types.js';

const CACHE_DOC_ID = 'screenshots_cache';

export class ShowcaseRepository extends BaseRepository<ShowcaseCacheDocument> {
  constructor() {
    super('discord_screenshots');
  }

  async getCache(): Promise<ShowcaseCacheDocument | null> {
    return this.findOne({ _id: CACHE_DOC_ID });
  }

  async updateCache(posts: ShowcasePost[]): Promise<void> {
    const now = new Date();
    await this.collection.updateOne(
      { _id: CACHE_DOC_ID },
      {
        $set: {
          posts,
          lastFetched: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
  }
}
