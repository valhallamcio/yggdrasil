import { gunzipSync } from 'node:zlib';
import { Reader } from './frame-codec.js';

/**
 * `biforesting:spike` (profiler plan phase 6a): `[varint 1][varint gzLen][gz utf8 report.json]`.
 * Mirrors the mod's shared `SpikePayloads`. The mod trims hotspots to keep the payload at or below
 * {@link MAX_SPIKE_PAYLOAD_BYTES}. The JSON is a schema-1 report with `kind: "spike"` and a
 * `trigger` block. {@link storeSpikeReport} in profile-store.ts checks and stores it.
 */

export const SPIKE_PAYLOAD_VERSION = 1;
export const MAX_SPIKE_PAYLOAD_BYTES = 256 * 1024;
/** Bounded inflate. The mod's local report.json can be larger, the payload never is. */
const MAX_SPIKE_JSON_BYTES = 16 * 1024 * 1024;

export function decodeSpike(payload: Buffer): Record<string, unknown> {
  const r = new Reader(payload);
  const version = r.varInt();
  if (version !== SPIKE_PAYLOAD_VERSION) throw new Error(`unsupported spike payload version ${version}`);
  const gzLen = r.varInt();
  const gz = r.bytes(gzLen);
  const raw: unknown = JSON.parse(gunzipSync(gz, { maxOutputLength: MAX_SPIKE_JSON_BYTES }).toString('utf8'));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('spike report is not a JSON object');
  }
  return raw as Record<string, unknown>;
}
