import { logger } from '../../core/logger/index.js';
import { decodeFrame, type OuterUnit, type Reassembler } from './frame-codec.js';
import { biforestingLinkManager } from './link-manager.js';

/**
 * Shared inbound pipeline for ONE outer unit (`{channel, frame}`), used by BOTH the raw-TCP
 * listener (`index.ts`) and the `/biforesting/` WebSocket route (`websocket/index.ts`).
 *
 * Runs the identical decode → HMAC-verify → per-session `Reassembler` → `link-manager` dispatch
 * the link has always used, so neither transport forks the HMAC/identity/dispatch logic. The only
 * transport-specific concern (parsing units out of the byte stream vs. one-per-message) lives in
 * the callers; everything past that point is here.
 *
 * The link is authenticated purely by the per-frame HMAC: a unit whose first frame fails
 * `decodeFrame` is counted as rejected and dropped, exactly like the TCP path.
 */
export function processOuterUnit(
  sessionId: string,
  unit: OuterUnit,
  reassembler: Reassembler,
  now: number,
  authKey: Buffer,
): void {
  const frame = decodeFrame(unit.channel, unit.frame, now, authKey);
  if (!frame) {
    biforestingLinkManager.noteRejected(sessionId);
    return;
  }
  biforestingLinkManager.noteAccepted(sessionId);
  const full = reassembler.add(unit.channel, frame);
  if (full) {
    void biforestingLinkManager
      .dispatch(sessionId, unit.channel, full)
      .catch((err) => logger.warn({ err, sessionId, channel: unit.channel }, 'biforesting-link: dispatch failed'));
  }
}
