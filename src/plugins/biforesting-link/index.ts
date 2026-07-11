import type { Plugin } from '../types.js';
import { logger } from '../../core/logger/index.js';
import { getAuthKey } from './auth-key.js';
import { biforestingLinkManager } from './link-manager.js';
import { ensureIndexes } from './persistence.js';
import { ensureInvIndexes } from './inv-store.js';
import { ensureMetricsIndexes, startDownsampleSweep } from './metrics-history.js';
import { opDispatcher, opsStore } from './ops-runtime.js';

/**
 * Biforesting play-phase link runtime: durable-ops boot (boot-reset + recovery sweep), metrics
 * downsampling, and the shared session/dispatch plumbing. Transport is the `/biforesting/`
 * WebSocket route on the main HTTPS server (`websocket/index.ts`) — no extra port.
 *
 * <p>Phase 9: the deprecated raw-TCP second-port listener (:8765) is GONE. The mod has been
 * WS-only since transport v2 (phase 1), and nothing on the fleet ever shipped the TCP dialer;
 * both paths always shared the session code (`registerSession` + `processOuterUnit`), so
 * removing the listener changes nothing for WS sessions.
 */
export class BiforestingLinkPlugin implements Plugin {
  readonly name = 'biforesting-link';
  private stopDownsample: (() => void) | null = null;

  async init(): Promise<void> {
    getAuthKey(); // fail fast if the PSK/authKey is missing or malformed
    await ensureIndexes();
    await opsStore.ensureIndexes();
    await ensureMetricsIndexes();
    await ensureInvIndexes();

    // Durable ops: boot-reset stranded `dispatched` ops, start the recovery sweep, and route
    // op_res/presence/link-up through the dispatcher.
    biforestingLinkManager.setOpSink(opDispatcher);
    await opDispatcher.start();

    // Metrics history (D13): hourly downsample of biforesting_metrics, swept every few minutes.
    this.stopDownsample = startDownsampleSweep();

    // "listening" now means: the link runtime is up and the WS route will accept sessions.
    biforestingLinkManager.listening = true;
    logger.info('biforesting-link: runtime up (transport = /biforesting/ WS on the main port)');
  }

  async shutdown(): Promise<void> {
    if (this.stopDownsample) {
      this.stopDownsample();
      this.stopDownsample = null;
    }
    opDispatcher.stop();
    biforestingLinkManager.setOpSink(null);
    biforestingLinkManager.listening = false;
    biforestingLinkManager.closeAll();
    logger.info({ plugin: this.name }, 'biforesting-link: runtime stopped');
  }
}
