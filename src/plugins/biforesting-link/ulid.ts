import { randomBytes } from 'node:crypto';

/**
 * Minimal ULID generator (https://github.com/ulid/spec) — 48-bit ms timestamp + 80 random bits,
 * Crockford base32, 26 chars, lexicographically time-sortable. Inline (~30 lines) to avoid a
 * dependency for the one thing `biforesting_ops` needs: sortable unique op ids.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(timeMs: number = Date.now()): string {
  let t = timeMs;
  const time = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    time[i] = ALPHABET[t % 32]!;
    t = Math.floor(t / 32);
  }

  const rnd = randomBytes(10); // 80 bits → 16 base32 chars
  const rand = new Array<string>(16);
  let acc = 0;
  let bits = 0;
  let out = 0;
  for (const byte of rnd) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5 && out < 16) {
      rand[out++] = ALPHABET[(acc >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  return time.join('') + rand.join('');
}
