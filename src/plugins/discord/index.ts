import type { Plugin } from '../types.js';
import type { Express } from 'express';
import type { Server as HttpServer } from 'node:http';
import { config } from '../../config/index.js';
import { eventBus } from '../../core/event-bus/index.js';
import { logger } from '../../core/logger/index.js';

// discord.js is an optional dependency — install with: npm install discord.js
// It is only imported when PLUGIN_DISCORD=true

const WEBHOOK_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Minimal interface for what we use from a discord.js Webhook. */
interface DiscordWebhook {
  token: string | null;
  send(message: { content: string; username?: string }): Promise<unknown>;
}

/** Minimal interface for what we use from a discord.js TextChannel. */
interface DiscordTextChannel {
  isTextBased(): true;
  send(content: string): Promise<unknown>;
  fetchWebhooks(): Promise<{ find(fn: (wh: DiscordWebhook) => boolean): DiscordWebhook | undefined }>;
  createWebhook(opts: { name: string; avatar?: string }): Promise<DiscordWebhook>;
}

interface CachedWebhook {
  webhook: DiscordWebhook;
  cachedAt: number;
}

export class DiscordPlugin implements Plugin {
  readonly name = 'discord';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  private readonly webhookCache = new Map<string, CachedWebhook>();
  private readonly crashLoopServers = new Set<string>();

  async init(_app: Express, _server: HttpServer): Promise<void> {
    if (!config.DISCORD_TOKEN) {
      throw new Error('PLUGIN_DISCORD=true but DISCORD_TOKEN is not set');
    }

    // Dynamic import keeps discord.js out of the startup path when plugin is disabled
    const { Client, GatewayIntentBits } = await import('discord.js');

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    // Discord events → internal events
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    this.client.on('interactionCreate', () => {
      // TODO: dispatch to slash command handlers in commands/
      logger.warn({ plugin: this.name }, 'Interaction received but no handler is registered');
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    await this.client.login(config.DISCORD_TOKEN);
    logger.info({ plugin: this.name }, 'Discord bot connected');

    // Subscribe to donation events and relay to Discord via channel webhooks
    eventBus.on('donation.received', ({ channelId, message }) => {
      void this.sendWebhook(channelId, { content: message });
    });

    // Subscribe to server crash/recovery events
    eventBus.on('server.crashed', ({ server, serverName, previousState, currentState, reason }) => {
      const channelId = config.DISCORD_SERVER_STATUS_CHANNEL_ID;
      if (!channelId) return;
      if (this.crashLoopServers.has(server)) return;

      const labels: Record<string, string> = {
        'crash':               'crashed',
        'console-crash':       'crashed (detected from console)',
        'startup-crash':       'crashed during startup',
        'startup-lost':        'lost during startup',
        'unexpected-restart':  'restarted unexpectedly',
        'restart-during-stop': 'restarted during shutdown',
        'stuck-starting':      'stuck starting',
        'stuck-stopping':      'stuck stopping',
        'stop-lost':           'lost during shutdown',
      };

      void this.sendMessage(
        channelId,
        `**${serverName}** (\`${server}\`) ${labels[reason] ?? 'encountered an issue'} (${previousState} → ${currentState})`,
      );
    });

    eventBus.on('server.recovered', ({ server, serverName }) => {
      const channelId = config.DISCORD_SERVER_STATUS_CHANNEL_ID;
      if (!channelId) return;
      if (this.crashLoopServers.has(server)) return;
      void this.sendMessage(channelId, `**${serverName}** (\`${server}\`) is back online.`);
    });

    eventBus.on('server.crash-loop.started', ({ server, serverName, crashCount }) => {
      this.crashLoopServers.add(server);
      const channelId = config.DISCORD_SERVER_STATUS_CHANNEL_ID;
      if (!channelId) return;
      void this.sendMessage(channelId, `**${serverName}** (\`${server}\`) is crash looping (${crashCount} crashes in 15 min).`);
    });

    eventBus.on('server.crash-loop.ended', ({ server, serverName }) => {
      this.crashLoopServers.delete(server);
      const channelId = config.DISCORD_SERVER_STATUS_CHANNEL_ID;
      if (!channelId) return;
      void this.sendMessage(channelId, `**${serverName}** (\`${server}\`) is no longer crash looping.`);
    });
  }

  async sendMessage(channelId: string, content: string): Promise<void> {
    if (!this.client) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const channel = await this.client.channels.fetch(channelId) as DiscordTextChannel | null;
      if (channel?.isTextBased()) {
        await channel.send(content);
      }
    } catch (err) {
      logger.error({ err, channelId }, 'Failed to send Discord message');
    }
  }

  async sendWebhook(
    channelId: string,
    message: { content: string; username?: string }
  ): Promise<void> {
    if (!this.client) return;
    try {
      const webhook = await this.getWebhook(channelId);
      if (!webhook) return;
      await webhook.send(message);
    } catch (err) {
      logger.error({ err, channelId }, 'Failed to send Discord webhook message');
    }
  }

  private async getWebhook(channelId: string): Promise<DiscordWebhook | null> {
    const cached = this.webhookCache.get(channelId);
    if (cached && Date.now() - cached.cachedAt < WEBHOOK_CACHE_TTL_MS) {
      return cached.webhook;
    }
    // Evict stale entry
    if (cached) this.webhookCache.delete(channelId);

    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const channel = await this.client.channels.fetch(channelId) as DiscordTextChannel | null;
      if (!channel?.isTextBased()) {
        logger.error({ channelId }, 'Discord channel not found or not text-based');
        return null;
      }

      const webhooks = await channel.fetchWebhooks();
      let webhook = webhooks.find((wh) => wh.token !== null) ?? null;

      if (!webhook) {
        logger.info({ channelId }, 'Creating webhook for Discord channel');
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        webhook = await channel.createWebhook({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          name: (this.client.user?.username as string | undefined) ?? 'Yggdrasil',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          avatar: this.client.user?.displayAvatarURL() as string | undefined,
        });
        logger.info({ channelId }, 'Webhook created for Discord channel');
      }

      this.webhookCache.set(channelId, { webhook, cachedAt: Date.now() });
      return webhook;
    } catch (err) {
      logger.error({ err, channelId }, 'Failed to get or create Discord webhook');
      return null;
    }
  }

  async shutdown(): Promise<void> {
    this.webhookCache.clear();
    if (this.client) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await this.client.destroy();
    }
    logger.info({ plugin: this.name }, 'Discord bot disconnected');
  }
}
