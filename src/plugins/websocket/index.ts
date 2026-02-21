import type { Plugin } from '../types.js';
import type { Express } from 'express';
import type { Server as HttpServer } from 'node:http';
import { logger } from '../../core/logger/index.js';

// ws is an optional dependency — install with: npm install ws @types/ws
// It is only imported when PLUGIN_WEBSOCKET=true

export class WebSocketPlugin implements Plugin {
  readonly name = 'websocket';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private wss: any;

  async init(_app: Express, server: HttpServer): Promise<void> {
    // Dynamic import keeps ws out of the startup path when plugin is disabled
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { WebSocketServer } = await import('ws');

    // Attach to the existing http.Server — same port as HTTP, no extra port needed.
    // The 'upgrade' event from HTTP is intercepted by ws automatically.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
    this.wss = new WebSocketServer({ server });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    this.wss.on('connection', (ws: any, req: import('http').IncomingMessage) => {
      const wsLogger = logger.child({ plugin: 'websocket', ip: req.socket.remoteAddress });
      wsLogger.info('Client connected');

      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      ws.on('message', (raw: Buffer) => {
        try {
          // Messages follow { type: string, payload: unknown } convention.
          // Add handlers in handlers/ directory and dispatch here.
          const msg = JSON.parse(raw.toString()) as { type: string; payload: unknown };
          wsLogger.debug({ msgType: msg.type }, 'Message received');
          // TODO: import and call per-type handlers from ./handlers/
        } catch {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          ws.send(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      ws.on('close', () => wsLogger.info('Client disconnected'));
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      ws.on('error', (err: unknown) => wsLogger.error({ err }, 'WebSocket error'));
    });

    logger.info({ plugin: this.name }, 'WebSocket server attached to HTTP server');
  }

  /**
   * Broadcasts a message to all connected WebSocket clients.
   * Can be called from services or event bus handlers.
   */
  broadcast(message: unknown): void {
    const data = JSON.stringify(message);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    this.wss?.clients.forEach((client: any) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (client.readyState === 1 /* OPEN */) client.send(data);
    });
  }

  async shutdown(): Promise<void> {
    if (!this.wss) return;
    await new Promise<void>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      this.wss.close((err: Error | undefined) => (err ? reject(err) : resolve()));
    });
    logger.info({ plugin: this.name }, 'WebSocket server closed');
  }
}
