import type { Plugin } from '../types.js';
import type { Express } from 'express';
import type { Server as HttpServer } from 'node:http';
import { config } from '../../config/index.js';
import { eventBus } from '../../core/event-bus/index.js';
import { logger } from '../../core/logger/index.js';

// discord.js is an optional dependency — install with: npm install discord.js
// It is only imported when PLUGIN_DISCORD=true

export class DiscordPlugin implements Plugin {
  readonly name = 'discord';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly webhookCache = new Map<string, any>();

  async init(_app: Express, _server: HttpServer): Promise<void> {
    if (!config.DISCORD_TOKEN) {
      throw new Error('PLUGIN_DISCORD=true but DISCORD_TOKEN is not set');
    }

    // Dynamic import keeps discord.js out of the startup path when plugin is disabled
    const { Client, GatewayIntentBits } = await import('discord.js');

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    // Discord events → internal events
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    this.client.on('interactionCreate', async (interaction: unknown) => {
      // Handle slash commands here — dispatch to handlers in commands/
      logger.debug({ plugin: this.name }, 'Interaction received');
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

      const labels: Record<string, string> = {
        'crash':               'crashed',
        'startup-crash':       'crashed during startup',
        'startup-lost':        'lost during startup',
        'unexpected-restart':  'restarted unexpectedly',
        'restart-during-stop': 'restarted during shutdown',
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
      void this.sendMessage(channelId, `**${serverName}** (\`${server}\`) is back online.`);
    });
  }

  async sendMessage(channelId: string, content: string): Promise<void> {
    if (!this.client) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const channel = await this.client.channels.fetch(channelId);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await channel?.send(content);
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
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await webhook.send(message);
    } catch (err) {
      logger.error({ err, channelId }, 'Failed to send Discord webhook message');
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getWebhook(channelId: string): Promise<any> {
    const cached = this.webhookCache.get(channelId);
    if (cached) return cached;

    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const channel = await this.client.channels.fetch(channelId);
      if (!channel) {
        logger.error({ channelId }, 'Discord channel not found');
        return null;
      }

      // Look for an existing webhook we can use
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const webhooks = await channel.fetchWebhooks();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
      let webhook = webhooks.find((wh: any) => wh.token);

      if (!webhook) {
        logger.info({ channelId }, 'Creating webhook for Discord channel');
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        webhook = await channel.createWebhook({
          name: this.client.user?.username ?? 'Yggdrasil',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          avatar: this.client.user?.displayAvatarURL(),
        });
        logger.info({ channelId }, 'Webhook created for Discord channel');
      }

      this.webhookCache.set(channelId, webhook);
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
