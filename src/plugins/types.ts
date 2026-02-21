import type { Server as HttpServer } from 'node:http';
import type { Express } from 'express';

/**
 * Every plugin must implement this interface.
 * Plugins are optional modules that extend the core server (WebSocket, Discord, Webhooks, etc.)
 * and are loaded only when their corresponding PLUGIN_* env var is set to "true".
 */
export interface Plugin {
  /** Unique plugin identifier — used for logging and config */
  readonly name: string;
  /**
   * Called during startup after Express and DB are ready.
   * Plugins that attach to the HTTP server (WebSocket, webhooks) receive both
   * the Express app and the raw http.Server.
   */
  init(app: Express, server: HttpServer): Promise<void>;
  /** Called during graceful shutdown in reverse registration order */
  shutdown(): Promise<void>;
}
