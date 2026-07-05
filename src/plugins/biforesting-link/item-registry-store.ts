import type { Collection, Db } from 'mongodb';
import { getDb } from '../../core/database/client.js';
import { logger } from '../../core/logger/index.js';
import type { ItemRegPayload, ItemVariant, LinkIdentity } from './types.js';
import { getPackLangMap, resolveLang } from './pack-lang-store.js';

/**
 * Item registry (phase 8): one doc per item per instanceKey, replaced wholesale on every
 * `biforesting:registry` dump — the item registry is frozen for the server's lifetime, so a dump
 * is authoritative and a re-dump (pack update + restart, or the `pull_item_registry` op) cleanly
 * supersedes the old list. The text index over display/mod/variant-display powers the
 * "I don't know the exact id" search endpoint that feeds VU's /give-item autocomplete.
 */

export interface ItemRegistryDoc {
  instanceKey: string;
  tag: string | null;
  serverId: string | null;
  source: string;
  id: string;
  num: number;
  mod: string;
  display: string;
  maxStack: number;
  variants: ItemVariant[];
  /** Flattened variant display strings — indexed so a metaitem variant name is searchable. */
  variantText: string;
  dumpedAt: Date;
}

let dbProvider: () => Db = getDb;

/** Test seam — mirror of quest-registry-store's. */
export function setItemRegDbProvider(provider: () => Db): void {
  dbProvider = provider;
  indexesEnsured = false;
}

function col(): Collection<ItemRegistryDoc> {
  return dbProvider().collection<ItemRegistryDoc>('biforesting_item_registry');
}

let indexesEnsured = false;

export async function ensureItemRegIndexes(): Promise<void> {
  if (indexesEnsured) return;
  await col().createIndex({ instanceKey: 1, id: 1 }, { unique: true });
  await col().createIndex({ instanceKey: 1, mod: 1 });
  await col().createIndex({ display: 'text', mod: 'text', variantText: 'text' });
  indexesEnsured = true;
}

/** Replace the instance's whole item registry with this dump (delete + insert, dump-authoritative). */
export async function saveItemRegistry(identity: LinkIdentity, payload: ItemRegPayload): Promise<void> {
  try {
    await ensureItemRegIndexes();
    // Load the pack's lang map ONCE and resolve any lang-key displays (R2) so search matches
    // the words a human types, not `mod.item.foo.name`. No-op when no lang was uploaded.
    const lang = await getPackLangMap(identity.tag);
    const dumpedAt = new Date();
    const docs: ItemRegistryDoc[] = payload.items.map((it) => {
      const variants = it.variants.map((v) => ({ meta: v.meta, display: resolveLang(lang, v.display) }));
      return {
        instanceKey: identity.instanceKey,
        tag: identity.tag,
        serverId: identity.serverId,
        source: payload.source,
        id: it.id,
        num: it.num,
        mod: it.mod,
        display: resolveLang(lang, it.display),
        maxStack: it.maxStack,
        variants,
        variantText: variants.map((v) => v.display).filter((d) => d).join(' '),
        dumpedAt,
      };
    });
    await col().deleteMany({ instanceKey: identity.instanceKey });
    if (docs.length > 0) {
      // ordered:false — one duplicate id in a malformed dump skips that row, not the rest
      await col().insertMany(docs, { ordered: false });
    }
  } catch (err) {
    logger.warn({ err, instanceKey: identity.instanceKey, count: payload.items.length }, 'biforesting-itemreg: dump persist failed');
  }
}

/** Registry meta for an instance: how many items, from which source, dumped when, best-effort? */
export async function itemRegistryInfo(
  instanceKey: string,
): Promise<{ count: number; source: string | null; dumpedAt: Date | null }> {
  await ensureItemRegIndexes();
  const newest = await col().find({ instanceKey }).sort({ dumpedAt: -1 }).limit(1).next();
  if (!newest) return { count: 0, source: null, dumpedAt: null };
  const count = await col().countDocuments({ instanceKey });
  return { count, source: newest.source, dumpedAt: newest.dumpedAt };
}

/**
 * Search items by free text. Resolution order: exact id → `mod:` prefix (list a mod's items) →
 * $text (stemmed display words, relevance-sorted) → case-insensitive substring on display/id.
 * No search string lists items id-sorted. Tens of thousands of rows per instance, so the text
 * index does the heavy lifting; the substring fallback only runs when $text finds nothing.
 */
export async function searchItems(instanceKey: string, search: string | undefined, limit = 25): Promise<ItemRegistryDoc[]> {
  await ensureItemRegIndexes();
  const q = search?.trim();
  if (!q) {
    return col().find({ instanceKey }).sort({ id: 1 }).limit(limit).toArray();
  }
  const byId = await col().find({ instanceKey, id: q }).limit(1).toArray();
  if (byId.length > 0) return byId;
  if (/^[a-z0-9_.-]+:$/i.test(q)) {
    const mod = q.slice(0, -1);
    return col().find({ instanceKey, mod }).sort({ id: 1 }).limit(limit).toArray();
  }
  const text = await col()
    .find({ instanceKey, $text: { $search: q } }, { projection: { score: { $meta: 'textScore' } } })
    .sort({ score: { $meta: 'textScore' } })
    .limit(limit)
    .toArray();
  if (text.length > 0) return text;
  const rx = new RegExp(escapeRegex(q), 'i');
  return col()
    .find({ instanceKey, $or: [{ display: rx }, { id: rx }, { variantText: rx }] })
    .limit(limit)
    .toArray();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
