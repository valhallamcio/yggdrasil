import { config } from '../../config/index.js';
import { logger } from '../../core/logger/index.js';
import { InternalError } from '../../shared/errors/index.js';
import type { ShowcaseRepository } from './showcase.repository.js';
import type { ShowcasePost, ShowcaseImage } from './showcase.types.js';
import { FALLBACK_POSTS } from './showcase.types.js';

// ── Discord REST API response shapes (internal) ────────────────────────────

interface DiscordAttachment {
  url: string;
  proxy_url?: string;
  width?: number;
  height?: number;
  content_type?: string;
}

interface DiscordEmbed {
  image?: { url: string; proxy_url?: string; width?: number; height?: number };
  thumbnail?: { url: string; proxy_url?: string; width?: number; height?: number };
}

interface DiscordMessage {
  id: string;
  author: { username: string; global_name?: string; avatar?: string; id: string };
  member?: { nick?: string };
  content: string;
  timestamp: string;
  attachments: DiscordAttachment[];
  embeds: DiscordEmbed[];
}

const DISCORD_API_BASE = 'https://discord.com/api/v10';

export class ShowcaseService {
  constructor(private readonly repo: ShowcaseRepository) {}

  /** Fetch messages with images from the configured Discord channel */
  async fetchFromDiscord(): Promise<ShowcasePost[]> {
    const channelId = config.DISCORD_SCREENSHOT_CHANNEL_ID;
    const token = config.DISCORD_TOKEN;

    if (!channelId || !token) {
      throw new InternalError('Discord screenshot channel ID or token not configured');
    }

    const url = `${DISCORD_API_BASE}/channels/${channelId}/messages?limit=100`;
    const response = await fetch(url, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const body = await response.text();
      logger.error({ status: response.status, body }, 'Discord API request failed');
      throw new InternalError(`Discord API returned ${response.status}`);
    }

    const messages = (await response.json()) as DiscordMessage[];
    return this.extractPosts(messages);
  }

  /** Refresh the MongoDB cache with fresh Discord data */
  async refreshCache(): Promise<{ postCount: number }> {
    const posts = await this.fetchFromDiscord();
    await this.repo.updateCache(posts);
    logger.info({ postCount: posts.length }, 'Showcase cache refreshed');
    return { postCount: posts.length };
  }

  /** Get screenshots for the API response */
  async getScreenshots(count: number): Promise<ShowcasePost[]> {
    const cache = await this.repo.getCache();

    if (cache && cache.posts.length > 0) {
      return this.selectForGallery(cache.posts, count);
    }

    logger.warn('Showcase cache empty, returning fallback posts');
    return FALLBACK_POSTS.slice(0, count);
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private extractPosts(messages: DiscordMessage[]): ShowcasePost[] {
    const posts: ShowcasePost[] = [];

    for (const msg of messages) {
      const images: ShowcaseImage[] = [];

      for (const att of msg.attachments) {
        if (att.content_type?.startsWith('image/')) {
          images.push({
            url: att.url,
            proxyUrl: att.proxy_url,
            width: att.width,
            height: att.height,
          });
        }
      }

      for (const embed of msg.embeds) {
        if (embed.image?.url) {
          images.push({
            url: embed.image.url,
            proxyUrl: embed.image.proxy_url,
            width: embed.image.width,
            height: embed.image.height,
          });
        }
      }

      if (images.length === 0) continue;

      const avatarHash = msg.author.avatar;
      const authorAvatar = avatarHash
        ? `https://cdn.discordapp.com/avatars/${msg.author.id}/${avatarHash}.png`
        : undefined;

      posts.push({
        messageId: msg.id,
        images,
        author: msg.member?.nick ?? msg.author.global_name ?? msg.author.username,
        authorAvatar,
        caption: msg.content?.slice(0, 200) ?? '',
        timestamp: msg.timestamp,
      });
    }

    return posts;
  }

  private selectForGallery(posts: ShowcasePost[], count: number): ShowcasePost[] {
    const sorted = [...posts].sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tb - ta;
    });

    return sorted.slice(0, count).map((post) => {
      const img = post.images[0];
      const w = img?.width ?? 0;
      const h = img?.height ?? 0;

      return {
        ...post,
        isLarge: w > h,
        isTall: h > w,
      };
    });
  }
}
