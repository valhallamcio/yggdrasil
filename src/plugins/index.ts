import type { Plugin } from './types.js';
import type { Express } from 'express';
import type { Server as HttpServer } from 'node:http';
import { config } from '../config/index.js';
import { logger } from '../core/logger/index.js';

export class PluginRegistry {
  private readonly registry: Plugin[] = [];

  register(plugin: Plugin): void {
    this.registry.push(plugin);
    logger.info({ plugin: plugin.name }, 'Plugin registered');
  }

  async initAll(app: Express, server: HttpServer): Promise<void> {
    for (const plugin of this.registry) {
      logger.info({ plugin: plugin.name }, 'Plugin initializing');
      await plugin.init(app, server);
      logger.info({ plugin: plugin.name }, 'Plugin initialized');
    }
  }

  async shutdownAll(): Promise<void> {
    for (const plugin of [...this.registry].reverse()) {
      logger.info({ plugin: plugin.name }, 'Plugin shutting down');
      await plugin.shutdown();
    }
  }
}

export const pluginRegistry = new PluginRegistry();

/**
 * Conditionally loads and registers enabled plugins using dynamic imports.
 * Disabled plugins never load their dependencies (e.g. discord.js, ws).
 */
export async function loadPlugins(): Promise<void> {
  if (config.PLUGIN_WEBSOCKET) {
    const { WebSocketPlugin } = await import('./websocket/index.js');
    pluginRegistry.register(new WebSocketPlugin());
  }
  if (config.PLUGIN_DISCORD) {
    const { DiscordPlugin } = await import('./discord/index.js');
    pluginRegistry.register(new DiscordPlugin());
  }
}
