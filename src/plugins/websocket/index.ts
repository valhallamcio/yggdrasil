import type { Plugin } from '../types.js';
import type { Express } from 'express';
import type { Server as HttpServer } from 'node:http';
import type WebSocket from 'ws';
import { logger } from '../../core/logger/index.js';
import { eventBus } from '../../core/event-bus/index.js';
import { config } from '../../config/index.js';
import { bifrostStateManager } from '../bifrost/state-manager.js';

const SNAPSHOT_INTERVAL_MS = 30_000;

export class WebSocketPlugin implements Plugin {
  readonly name = 'websocket';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private wss: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private bifrostWss: any;
  private readonly consoleSubscriptions = new Map<string, Set<WebSocket>>();
  private snapshotInterval: ReturnType<typeof setInterval> | null = null;

  async init(_app: Express, server: HttpServer): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { WebSocketServer } = await import('ws');

    // ── Dashboard WS server (path: /) ───────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
    this.wss = new WebSocketServer({ noServer: true });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    this.wss.on('connection', (ws: WebSocket, req: import('http').IncomingMessage) => {
      const wsLogger = logger.child({ plugin: 'websocket', ip: req.socket.remoteAddress });

      const url = new URL(req.url ?? '', `http://${req.headers.host}`);
      const token = url.searchParams.get('token');

      if (!token || !config.API_KEYS.includes(token)) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        ws.send(JSON.stringify({ error: 'Unauthorized' }));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        ws.close(1008, 'Unauthorized');
        wsLogger.warn('Dashboard client rejected: invalid or missing token');
        return;
      }

      wsLogger.info('Dashboard client connected');

      // Send current proxy state immediately so the client doesn't have to wait
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      ws.send(JSON.stringify({ type: 'proxy.state', payload: bifrostStateManager.getSnapshot() }));

      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      ws.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString()) as { type: string; payload?: { server?: string } };
          wsLogger.debug({ msgType: msg.type }, 'Message received');
          this.handleDashboardMessage(ws, msg);
        } catch {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          ws.send(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      ws.on('close', () => {
        wsLogger.info('Dashboard client disconnected');
        this.removeClientFromAllSubscriptions(ws);
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      ws.on('error', (err: unknown) => wsLogger.error({ err }, 'WebSocket error'));
    });

    // ── Bifrost WS server (path: /bifrost/) ─────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
    this.bifrostWss = new WebSocketServer({ noServer: true });

    // Route HTTP upgrade requests to the correct WSS by pathname.
    // Using noServer on both instances avoids ws's built-in path check calling
    // abortHandshake(400) on requests destined for the other server.
    server.on('upgrade', (req, socket, head) => {
      const pathname = req.url?.split('?')[0] ?? '/';
      if (pathname === '/bifrost/') {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        this.bifrostWss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          this.bifrostWss.emit('connection', ws, req);
        });
      } else if (pathname === '/') {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        this.wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          this.wss.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    this.bifrostWss.on('connection', (ws: WebSocket, req: import('http').IncomingMessage) => {
      const wsLogger = logger.child({ plugin: 'websocket/bifrost', ip: req.socket.remoteAddress });

      const url = new URL(req.url ?? '', `http://${req.headers.host}`);
      const token = url.searchParams.get('token');

      if (!token || !config.API_KEYS.includes(token)) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        ws.send(JSON.stringify({ error: 'Unauthorized' }));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        ws.close(1008, 'Unauthorized');
        wsLogger.warn('Bifrost client rejected: invalid or missing token');
        return;
      }

      wsLogger.info('Bifrost proxy connected');
      bifrostStateManager.setConnected(ws);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      ws.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString()) as { type: string; payload?: Record<string, unknown> };
          wsLogger.debug({ msgType: msg.type }, 'Bifrost message received');
          bifrostStateManager.handleMessage(msg.type, msg.payload ?? {});
        } catch {
          wsLogger.warn('Invalid JSON from Bifrost');
        }
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      ws.on('close', () => {
        wsLogger.warn('Bifrost proxy disconnected');
        bifrostStateManager.onDisconnect(ws);
        // Broadcast updated (disconnected) state to dashboard clients
        this.broadcast({ type: 'proxy.state', payload: bifrostStateManager.getSnapshot() });
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      ws.on('error', (err: unknown) => wsLogger.error({ err }, 'Bifrost WebSocket error'));
    });

    // ── Periodic full-state snapshot ─────────────────────────────────────────
    this.snapshotInterval = setInterval(() => {
      this.broadcast({ type: 'proxy.state', payload: bifrostStateManager.getSnapshot() });
    }, SNAPSHOT_INTERVAL_MS);

    // ── Server events (broadcast to all dashboard clients) ───────────────────
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

    eventBus.on('server.crash-loop.started', (payload) => {
      this.broadcast({ type: 'server.crash-loop.started', payload });
    });

    eventBus.on('server.crash-loop.ended', (payload) => {
      this.broadcast({ type: 'server.crash-loop.ended', payload });
    });

    // ── Player events (broadcast to all dashboard clients) ───────────────────
    eventBus.on('player.joined', (payload) => {
      this.broadcast({ type: 'player.joined', payload });
    });

    eventBus.on('player.left', (payload) => {
      this.broadcast({ type: 'player.left', payload });
    });

    eventBus.on('player.server.changed', (payload) => {
      this.broadcast({ type: 'player.server.changed', payload });
    });

    eventBus.on('player.list.updated', (payload) => {
      this.broadcast({ type: 'player.list.updated', payload });
    });

    eventBus.on('player.chat', (payload) => {
      this.broadcast({ type: 'player.chat', payload });
    });

    // ── Console channel (per-server subscriptions) ────────────────────────────
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
   * Broadcasts a message to all connected dashboard WebSocket clients.
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
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
      this.snapshotInterval = null;
    }
    this.consoleSubscriptions.clear();

    const closeWss = (wss: unknown): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        if (!wss) return resolve();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
        (wss as any).close((err: Error | undefined) => (err ? reject(err) : resolve()));
      });

    await Promise.all([closeWss(this.wss), closeWss(this.bifrostWss)]);
    logger.info({ plugin: this.name }, 'WebSocket server closed');
  }

  // ── Dashboard message handling ───────────────────────────────────────────

  private handleDashboardMessage(
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
