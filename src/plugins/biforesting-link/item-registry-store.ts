import type { Collection, Db } from 'mongodb';
import { getDb } from '../../core/database/client.js';
import { logger } from '../../core/logger/index.js';
import type { ItemRegPayload, ItemVariant, LinkIdentity } from './types.js';
import { getPackLangMap, resolveLang } from './pack-lang-store.js';
import { getActiveGeneration, isDuplicateKeyOnly, setActiveGeneration, withGenerationLock } from './registry-meta.js';
import { ulid } from './ulid.js';

/**
 * Item registry (phase 8): one doc per item per instanceKey — the item registry is frozen for the
 * server's lifetime, so a dump is authoritative and a re-dump (pack update + restart, or the
 * `pull_item_registry` op) cleanly supersedes the old list. The text index over
 * display/mod/variant-display powers the "I don't know the exact id" search endpoint that feeds
 * VU's /give-item autocomplete.
 *
 * Persistence is generation-swapped (see registry-meta.ts): rows are tagged with a `dumpId`,
 * inserted BEFORE the active-generation pointer flips, and older generations are swept after.
 * A failed insert discards the new generation and keeps the previous one readable — a dump can
 * no longer wipe the registry by failing halfway.
 */

export interface ItemRegistryDoc {
  instanceKey: string;
  tag: string | null;
  serverId: string | null;
  source: string;
  dumpId: string;
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
  // Pre-generation index shapes can't host two generations at once (unique {instanceKey, id})
  // and Mongo allows one text index per collection — drop them before creating the new shapes.
  for (const legacy of ['instanceKey_1_id_1', 'instanceKey_1_mod_1', 'display_text_mod_text_variantText_text']) {
    try {
      await col().dropIndex(legacy);
    } catch {
      // absent — fine
    }
  }
  await col().createIndex({ instanceKey: 1, dumpId: 1, id: 1 }, { unique: true });
  await col().createIndex({ instanceKey: 1, dumpId: 1, mod: 1 });
  // Equality prefixes on a text index REQUIRE every $text query to filter both fields — all
  // read paths go through activeFilter(), which supplies exactly that.
  await col().createIndex({ instanceKey: 1, dumpId: 1, display: 'text', mod: 'text', variantText: 'text' });
  indexesEnsured = true;
}

/** Read filter pinning an instance to its active generation; null = no completed dump yet. */
async function activeFilter(instanceKey: string): Promise<{ instanceKey: string; dumpId: string } | null> {
  const gen = await getActiveGeneration(dbProvider(), 'item', instanceKey);
  return gen ? { instanceKey, dumpId: gen.activeDumpId } : null;
}

/**
 * Persist a dump as a new generation and flip the active pointer (dump-authoritative — an empty
 * dump legitimately empties the registry). Serialized per instanceKey so interleaved dumps from
 * a reconnecting server can't cross their insert/flip/sweep steps.
 */
export async function saveItemRegistry(identity: LinkIdentity, payload: ItemRegPayload): Promise<void> {
  try {
    await ensureItemRegIndexes();
    await withGenerationLock(`item:${identity.instanceKey}`, async () => {
      // Load the pack's lang map ONCE and resolve any lang-key displays (R2) so search matches
      // the words a human types, not `mod.item.foo.name`. No-op when no lang was uploaded.
      const lang = await getPackLangMap(identity.tag);
      const dumpedAt = new Date();
      const dumpId = ulid();
      const docs: ItemRegistryDoc[] = payload.items.map((it) => {
        const variants = it.variants.map((v) => ({ meta: v.meta, display: resolveLang(lang, v.display) }));
        return {
          instanceKey: identity.instanceKey,
          tag: identity.tag,
          serverId: identity.serverId,
          source: payload.source,
          dumpId,
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
      if (docs.length > 0) {
        try {
          // ordered:false — one duplicate id in a malformed dump skips that row, not the rest
          await col().insertMany(docs, { ordered: false });
        } catch (err) {
          if (!isDuplicateKeyOnly(err)) {
            // Unknown partial state: discard this generation, the previous one stays active.
            await col().deleteMany({ instanceKey: identity.instanceKey, dumpId });
            throw err;
          }
          logger.warn({ instanceKey: identity.instanceKey }, 'biforesting-itemreg: duplicate ids in dump — kept first occurrence of each');
        }
      }
      const count = await col().countDocuments({ instanceKey: identity.instanceKey, dumpId });
      await setActiveGeneration(dbProvider(), 'item', identity.instanceKey, {
        activeDumpId: dumpId,
        source: payload.source,
        count,
        dumpedAt,
      });
      // Sweep superseded generations — also matches legacy pre-generation rows (no dumpId field).
      await col().deleteMany({ instanceKey: identity.instanceKey, dumpId: { $ne: dumpId } });
    });
  } catch (err) {
    logger.warn(
      { err, instanceKey: identity.instanceKey, count: payload.items.length },
      'biforesting-itemreg: dump persist failed (previous registry generation kept)',
    );
  }
}

/** Registry meta for an instance: how many items, from which source, dumped when. */
export async function itemRegistryInfo(
  instanceKey: string,
): Promise<{ count: number; source: string | null; dumpedAt: Date | null }> {
  const gen = await getActiveGeneration(dbProvider(), 'item', instanceKey);
  if (!gen) return { count: 0, source: null, dumpedAt: null };
  return { count: gen.count, source: gen.source, dumpedAt: gen.dumpedAt };
}

/**
 * Search items by free text. Resolution order: exact id → `mod:` prefix (list a mod's items) →
 * $text (stemmed display words, relevance-sorted) → case-insensitive substring on display/id.
 * No search string lists items id-sorted. Tens of thousands of rows per instance, so the text
 * index does the heavy lifting; the substring fallback only runs when $text finds nothing.
 */
export async function searchItems(instanceKey: string, search: string | undefined, limit = 25): Promise<ItemRegistryDoc[]> {
  await ensureItemRegIndexes();
  const base = await activeFilter(instanceKey);
  if (!base) return [];
  const q = search?.trim();
  if (!q) {
    return col().find(base).sort({ id: 1 }).limit(limit).toArray();
  }
  const byId = await col().find({ ...base, id: q }).limit(1).toArray();
  if (byId.length > 0) return byId;
  if (/^[a-z0-9_.-]+:$/i.test(q)) {
    const mod = q.slice(0, -1);
    return col().find({ ...base, mod }).sort({ id: 1 }).limit(limit).toArray();
  }
  const text = await col()
    .find({ ...base, $text: { $search: q } }, { projection: { score: { $meta: 'textScore' } } })
    .sort({ score: { $meta: 'textScore' } })
    .limit(limit)
    .toArray();
  if (text.length > 0) return text;
  const rx = new RegExp(escapeRegex(q), 'i');
  return col()
    .find({ ...base, $or: [{ display: rx }, { id: rx }, { variantText: rx }] })
    .limit(limit)
    .toArray();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
