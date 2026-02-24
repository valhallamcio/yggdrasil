import type { Plugin } from '../types.js';
import type { Express } from 'express';
import type { Server as HttpServer } from 'node:http';
import type WebSocket from 'ws';
import { logger } from '../../core/logger/index.js';
import { eventBus } from '../../core/event-bus/index.js';
import { config } from '../../config/index.js';

export class WebSocketPlugin implements Plugin {
  readonly name = 'websocket';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private wss: any;
  private readonly consoleSubscriptions = new Map<string, Set<WebSocket>>();

  async init(_app: Express, server: HttpServer): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { WebSocketServer } = await import('ws');

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
    this.wss = new WebSocketServer({ server });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    this.wss.on('connection', (ws: WebSocket, req: import('http').IncomingMessage) => {
      const wsLogger = logger.child({ plugin: 'websocket', ip: req.socket.remoteAddress });

      // Validate API key from query string (?token=...)
      const url = new URL(req.url ?? '', `http://${req.headers.host}`);
      const token = url.searchParams.get('token');

      if (!token || !config.API_KEYS.includes(token)) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        ws.send(JSON.stringify({ error: 'Unauthorized' }));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        ws.close(1008, 'Unauthorized');
        wsLogger.warn('Client rejected: invalid or missing token');
        return;
      }

      wsLogger.info('Client connected');

      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      ws.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString()) as { type: string; payload?: { server?: string } };
          wsLogger.debug({ msgType: msg.type }, 'Message received');
          this.handleClientMessage(ws, msg);
        } catch {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          ws.send(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      ws.on('close', () => {
        wsLogger.info('Client disconnected');
        this.removeClientFromAllSubscriptions(ws);
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      ws.on('error', (err: unknown) => wsLogger.error({ err }, 'WebSocket error'));
    });

    // ── Status channel (broadcast to all) ───────────────────────────────────
    eventBus.on('server.stats', (payload) => {
      this.broadcast({ type: 'server.stats', payload });
    });

    eventBus.on('server.state.changed', (payload) => {
      this.broadcast({ type: 'server.state.changed', payload });
    });

    eventBus.on('server.crashed', (payload) => {
      this.broadcast({ type: 'server.crashed', payload });
    });

    eventBus.on('server.recovered', (payload) => {
      this.broadcast({ type: 'server.recovered', payload });
    });

    // ── Console channel (per-server subscriptions) ──────────────────────────
    eventBus.on('server.console.output', ({ server, line }) => {
      const subscribers = this.consoleSubscriptions.get(server);
      if (!subscribers || subscribers.size === 0) return;
      const data = JSON.stringify({ type: 'console.output', payload: { server, line } });
      for (const client of subscribers) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        if ((client as unknown as any).readyState === 1 /* OPEN */) (client as unknown as any).send(data);
      }
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
    this.consoleSubscriptions.clear();
    if (!this.wss) return;
    await new Promise<void>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      this.wss.close((err: Error | undefined) => (err ? reject(err) : resolve()));
    });
    logger.info({ plugin: this.name }, 'WebSocket server closed');
  }

  // ── Console subscription management ─────────────────────────────────────

  private handleClientMessage(
    ws: WebSocket,
    msg: { type: string; payload?: { server?: string } },
  ): void {
    switch (msg.type) {
      case 'console.subscribe': {
        const tag = msg.payload?.server;
        if (!tag) return;
        let subscribers = this.consoleSubscriptions.get(tag);
        if (!subscribers) {
          subscribers = new Set();
          this.consoleSubscriptions.set(tag, subscribers);
        }
        subscribers.add(ws);
        logger.debug({ tag }, 'Client subscribed to console');
        break;
      }

      case 'console.unsubscribe': {
        const tag = msg.payload?.server;
        if (!tag) return;
        const subs = this.consoleSubscriptions.get(tag);
        if (subs) {
          subs.delete(ws);
          if (subs.size === 0) this.consoleSubscriptions.delete(tag);
        }
        logger.debug({ tag }, 'Client unsubscribed from console');
        break;
      }
    }
  }

  private removeClientFromAllSubscriptions(ws: WebSocket): void {
    for (const [tag, subscribers] of this.consoleSubscriptions) {
      subscribers.delete(ws);
      if (subscribers.size === 0) this.consoleSubscriptions.delete(tag);
    }
  }
}
