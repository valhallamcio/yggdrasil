import { pbkdf2Sync } from 'node:crypto';
import { config } from '../../config/index.js';

/**
 * The play-phase link HMAC key. Identical derivation to Bifrost's proxy-auth key
 * (`Bifrost/src/core/biforesting.ts`) and the mod's build-embedded `authKey`:
 *
 *   PBKDF2-HMAC-SHA256(BIFORESTING_PSK, salt="Biforesting-ProxyAuth-v1", 10000 iters, 32 bytes)
 *
 * A pre-derived 64-hex `BIFORESTING_AUTHKEY_HEX` overrides the PSK derivation
 * (matches `bifrost-lib/test/ygg_mock.py` `load_auth_key`). Cached after first call.
 */

const PROXY_AUTH_SALT = 'Biforesting-ProxyAuth-v1';
const ITERATIONS = 10_000;
const KEY_LEN = 32;

let cached: Buffer | null = null;

export function getAuthKey(): Buffer {
  if (cached) return cached;

  const hex = config.BIFORESTING_AUTHKEY_HEX?.trim();
  if (hex) {
    if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
      throw new Error('BIFORESTING_AUTHKEY_HEX must be exactly 64 hex chars (32 bytes)');
    }
    cached = Buffer.from(hex, 'hex');
    return cached;
  }

  const psk = config.BIFORESTING_PSK;
  if (!psk) {
    throw new Error('Biforesting link enabled but neither BIFORESTING_PSK nor BIFORESTING_AUTHKEY_HEX is set');
  }
  cached = pbkdf2Sync(psk, PROXY_AUTH_SALT, ITERATIONS, KEY_LEN, 'sha256');
  return cached;
}
