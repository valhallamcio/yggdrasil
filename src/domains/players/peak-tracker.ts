import { eventBus } from '../../core/event-bus/index.js';
import { logger } from '../../core/logger/index.js';
import type { PeakRecord } from './players.types.js';

const HYSTERESIS = 2;

interface PeakState {
  highWaterMark: number;
  highWaterTimestamp: Date;
  lowWaterMark: number;
  rising: boolean;
  lastPeak: PeakRecord | null;
}

function createState(): PeakState {
  return { highWaterMark: 0, highWaterTimestamp: new Date(), lowWaterMark: 0, rising: true, lastPeak: null };
}

function updateState(state: PeakState, count: number): void {
  if (count >= state.highWaterMark) {
    state.highWaterMark = count;
    state.highWaterTimestamp = new Date();
    state.rising = true;
  } else if (state.rising && state.highWaterMark - count >= HYSTERESIS) {
    // Confirmed peak — count dropped meaningfully
    state.lastPeak = { count: state.highWaterMark, timestamp: state.highWaterTimestamp };
    state.rising = false;
    state.lowWaterMark = count;
  } else if (!state.rising) {
    state.lowWaterMark = Math.min(state.lowWaterMark, count);
    if (count > state.lowWaterMark + HYSTERESIS) {
      // Started rising again
      state.highWaterMark = count;
      state.highWaterTimestamp = new Date();
      state.rising = true;
    }
  }
}

class PeakTracker {
  private globalState = createState();
  private serverStates = new Map<string, PeakState>();
  private listening = false;

  start(): void {
    this.listening = true;
    eventBus.on('player.list.updated', this.onListUpdated);
    logger.info('Peak tracker started');
  }

  stop(): void {
    this.listening = false;
    eventBus.off('player.list.updated', this.onListUpdated);
    logger.info('Peak tracker stopped');
  }

  getLastPeak(server?: string): PeakRecord | null {
    if (server) {
      return this.serverStates.get(server)?.lastPeak ?? null;
    }
    return this.globalState.lastPeak;
  }

  private onListUpdated = (payload: {
    servers: Record<string, Array<{ username: string }>>;
    count: number;
  }): void => {
    if (!this.listening) return;

    updateState(this.globalState, payload.count);

    for (const [server, players] of Object.entries(payload.servers)) {
      let state = this.serverStates.get(server);
      if (!state) {
        state = createState();
        this.serverStates.set(server, state);
      }
      updateState(state, players.length);
    }
  };
}

export const peakTracker = new PeakTracker();
