import type { Collection, Db } from 'mongodb';
import { getDb } from '../../core/database/client.js';
import { logger } from '../../core/logger/index.js';

/**
 * Per-pack language maps (phase 8, R2 fallback). Some packs ship quest/item names as lang KEYS
 * that only resolve client-side (nomifactory's BQ titles are `nomifactory.quest.*.title`), so a
 * server-side dump stores raw keys — useless for search. Uploading the pack's `en_us` lang here
 * lets the item/quest stores resolve those keys to real text AT INGEST, so search matches the
 * words a human would type. Keyed by `pack` (== the server tag in this network).
 *
 * <p>Resolution is exact-key only: a stored display is replaced iff it is verbatim a key in the
 * map. Text that already reads as English (has spaces, isn't a key) is left untouched — so this
 * is safe to run over every dump regardless of whether the pack actually needs it.
 */

export interface PackLangDoc {
  pack: string;
  lang: Record<string, string>;
  count: number;
  updatedAt: Date;
}

let dbProvider: () => Db = getDb;

export function setPackLangDbProvider(provider: () => Db): void {
  dbProvider = provider;
  indexesEnsured = false;
  cache.clear();
}

function col(): Collection<PackLangDoc> {
  return dbProvider().collection<PackLangDoc>('biforesting_pack_lang');
}

let indexesEnsured = false;

async function ensureIndexes(): Promise<void> {
  if (indexesEnsured) return;
  await col().createIndex({ pack: 1 }, { unique: true });
  indexesEnsured = true;
}

/** Upsert a pack's lang map (replaces the whole map — the upload is authoritative). */
export async function savePackLang(pack: string, lang: Record<string, string>): Promise<number> {
  await ensureIndexes();
  const count = Object.keys(lang).length;
  await col().updateOne(
    { pack },
    { $set: { pack, lang, count, updatedAt: new Date() } },
    { upsert: true },
  );
  cache.delete(pack);
  return count;
}

// Small TTL cache so a multi-thousand-item ingest loads the pack's lang map once, not per row.
const cache = new Map<string, { map: Record<string, string> | null; at: number }>();
const CACHE_TTL_MS = 60_000;

/** Cached lang map for a pack (null if none uploaded). Pass a monotonic `now` in tests. */
export async function getPackLangMap(pack: string | null, now = Date.now()): Promise<Record<string, string> | null> {
  if (!pack) return null;
  const hit = cache.get(pack);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.map;
  let map: Record<string, string> | null = null;
  try {
    await ensureIndexes();
    const doc = await col().findOne({ pack });
    map = doc?.lang ?? null;
  } catch (err) {
    logger.warn({ err, pack }, 'biforesting-packlang: lookup failed');
    map = null;
  }
  cache.set(pack, { map, at: now });
  return map;
}

/** Replace `text` with its lang value iff `text` is verbatim a key in `map`; else unchanged. */
export function resolveLang(map: Record<string, string> | null, text: string): string {
  if (!map || !text) return text;
  const hit = map[text];
  return typeof hit === 'string' && hit.length > 0 ? hit : text;
}
