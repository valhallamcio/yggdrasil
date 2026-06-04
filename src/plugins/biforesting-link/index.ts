import { createServer, type Server as NetServer, type Socket } from 'node:net';
import type { Plugin } from '../types.js';
import { config } from '../../config/index.js';
import { logger } from '../../core/logger/index.js';
import { getAuthKey } from './auth-key.js';
import { parseOuterUnits, Reassembler, MAX_INBOUND_FRAME } from './frame-codec.js';
import { biforestingLinkManager } from './link-manager.js';
import { processOuterUnit } from './session-processor.js';
import { ensureIndexes } from './persistence.js';

/** Idle sockets are dropped after this long with no traffic (the mod streams metrics ~1 Hz). */
const SOCKET_TIMEOUT_MS = 300_000;
/** Drop a connection whose unparsed buffer grows past this (a single frame caps at MAX_INBOUND_FRAME). */
const MAX_BUFFER_BYTES = MAX_INBOUND_FRAME + 1024;

/**
 * Standalone raw-TCP listener for the Biforesting play-phase link. Backend mods dial in and stream
 * `metrics`/`registry`/`quest`/`chunks`; we authenticate + reassemble frames (`frame-codec.ts`) and
 * route reassembled messages to `biforestingLinkManager`. Separate from the player-presence WebSocket
 * (`/bifrost/`). Only reacts to inbound sockets, so servers without the link configured are unaffected.
 *
 * @deprecated Superseded by the `/biforesting/` WebSocket route on the main HTTPS server
 * (`websocket/index.ts`), which carries the same frames over the existing port. This raw second-port
 * listener is kept for one release as a fallback; both paths share the same session/dispatch code
 * (`registerSession` + `processOuterUnit`) via the transport-agnostic `LinkTransport`.
 */
export class BiforestingLinkPlugin implements Plugin {
  readonly name = 'biforesting-link';
  private server: NetServer | null = null;
  private connSeq = 0;

  // The link is a standalone TCP server, so the Express app / HTTP server args are unused.
  async init(): Promise<void> {
    getAuthKey(); // fail fast if the PSK/authKey is missing or malformed
    await ensureIndexes();

    const port = config.BIFORESTING_LINK_PORT;
    const host = config.BIFORESTING_LINK_HOST;

    this.server = createServer((socket) => this.handleConnection(socket));
    this.server.on('error', (err) => logger.error({ err }, 'biforesting-link: TCP server error'));

    await new Promise<void>((resolve, reject) => {
      const srv = this.server!;
      srv.once('error', reject);
      srv.listen(port, host, () => {
        srv.off('error', reject);
        resolve();
      });
    });

    biforestingLinkManager.listening = true;
    logger.info({ host, port }, 'biforesting-link: TCP link listening (firewall to backend hosts only)');
  }

  private handleConnection(socket: Socket): void {
    const remote = `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? 0}`;
    const sessionId = `${remote}#${++this.connSeq}`;
    const authKey = getAuthKey();
    const reassembler = new Reassembler();
    let buffer: Buffer = Buffer.alloc(0);

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    socket.setTimeout(SOCKET_TIMEOUT_MS);

    // TCP flavour of the transport-agnostic session handle (mirrors the WS `ws.send` wrapper).
    biforestingLinkManager.registerSession(
      sessionId,
      {
        writable: () => !socket.destroyed && socket.writable,
        send: (outerUnit) => void socket.write(outerUnit),
        close: () => socket.destroy(),
      },
      remote,
    );
    logger.info({ sessionId, remote }, 'biforesting-link: connection opened');

    socket.on('data', (data: Buffer) => {
      biforestingLinkManager.noteBytes(sessionId, data.length);
      buffer = buffer.length === 0 ? data : Buffer.concat([buffer, data]);

      let parsed;
      try {
        parsed = parseOuterUnits(buffer);
      } catch (err) {
        logger.warn({ err, sessionId }, 'biforesting-link: malformed outer framing — dropping connection');
        socket.destroy();
        return;
      }
      buffer = parsed.rest;

      if (buffer.length > MAX_BUFFER_BYTES) {
        logger.warn({ sessionId, bytes: buffer.length }, 'biforesting-link: oversized buffer — dropping connection');
        socket.destroy();
        return;
      }

      const now = Date.now();
      for (const unit of parsed.units) {
        processOuterUnit(sessionId, unit, reassembler, now, authKey);
      }
    });

    socket.on('timeout', () => {
      logger.info({ sessionId }, 'biforesting-link: socket idle timeout');
      socket.destroy();
    });
    socket.on('error', (err) => logger.debug({ err, sessionId }, 'biforesting-link: socket error'));
    socket.on('close', () => biforestingLinkManager.removeSession(sessionId));
  }

  async shutdown(): Promise<void> {
    biforestingLinkManager.listening = false;
    biforestingLinkManager.closeAll();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    logger.info({ plugin: this.name }, 'biforesting-link: TCP link closed');
  }
}
