import type { Collection, Db } from 'mongodb';
import { getDb } from '../../core/database/client.js';
import { logger } from '../../core/logger/index.js';
import type { LinkIdentity, QuestRegPayload } from './types.js';
import { getPackLangMap, resolveLang } from './pack-lang-store.js';
import { getActiveGeneration, isDuplicateKeyOnly, setActiveGeneration, withGenerationLock } from './registry-meta.js';
import { ulid } from './ulid.js';

/**
 * Quest registry (phase 6): one doc per quest per instanceKey — the dump is authoritative, so
 * quests removed from the pack disappear here too. The text index over title/subtitle/chapterTitle
 * powers the "I don't know the quest ID" search endpoint; ids stay opaque strings (FTBQ hex / BQ
 * int / GTNH base64).
 *
 * Persistence is generation-swapped (see registry-meta.ts): rows insert under a fresh `dumpId`
 * BEFORE the active pointer flips, older generations are swept after, and a failed insert keeps
 * the previous generation readable instead of leaving the registry empty/partial.
 */

export interface QuestRegistryDoc {
  instanceKey: string;
  tag: string | null;
  serverId: string | null;
  source: string;
  dumpId: string;
  questId: string;
  chapter: string;
  chapterTitle: string;
  title: string;
  subtitle: string;
  taskCount: number;
  tasks: string[];
  dumpedAt: Date;
}

let dbProvider: () => Db = getDb;

/** Test seam — mirror of inv-store's. */
export function setQuestRegDbProvider(provider: () => Db): void {
  dbProvider = provider;
  indexesEnsured = false;
}

function col(): Collection<QuestRegistryDoc> {
  return dbProvider().collection<QuestRegistryDoc>('biforesting_quest_registry');
}

let indexesEnsured = false;

export async function ensureQuestRegIndexes(): Promise<void> {
  if (indexesEnsured) return;
  // Pre-generation shapes can't host two generations (unique {instanceKey, questId}) and Mongo
  // allows one text index per collection — drop the old names before creating the new shapes.
  for (const legacy of ['instanceKey_1_questId_1', 'title_text_subtitle_text_chapterTitle_text']) {
    try {
      await col().dropIndex(legacy);
    } catch {
      // absent — fine
    }
  }
  await col().createIndex({ instanceKey: 1, dumpId: 1, questId: 1 }, { unique: true });
  // Equality prefixes on a text index REQUIRE every $text query to filter both fields — all
  // read paths go through activeFilter(), which supplies exactly that.
  await col().createIndex({ instanceKey: 1, dumpId: 1, title: 'text', subtitle: 'text', chapterTitle: 'text' });
  indexesEnsured = true;
}

/** Read filter pinning an instance to its active generation; null = no completed dump yet. */
async function activeFilter(instanceKey: string): Promise<{ instanceKey: string; dumpId: string } | null> {
  const gen = await getActiveGeneration(dbProvider(), 'quest', instanceKey);
  return gen ? { instanceKey, dumpId: gen.activeDumpId } : null;
}

/**
 * Persist a dump as a new generation and flip the active pointer (dump-authoritative — an empty
 * dump legitimately empties the registry). Serialized per instanceKey so interleaved dumps from
 * a reconnecting server can't cross their insert/flip/sweep steps.
 */
export async function saveQuestRegistry(identity: LinkIdentity, payload: QuestRegPayload): Promise<void> {
  try {
    await ensureQuestRegIndexes();
    await withGenerationLock(`quest:${identity.instanceKey}`, async () => {
      // R2 fallback: resolve lang-key titles (nomifactory BQ ships client-only lang) once per dump
      // so BQ search works there. No-op when no lang was uploaded for this pack.
      const lang = await getPackLangMap(identity.tag);
      const dumpedAt = new Date();
      const dumpId = ulid();
      const docs: QuestRegistryDoc[] = payload.quests.map((q) => ({
        instanceKey: identity.instanceKey,
        tag: identity.tag,
        serverId: identity.serverId,
        source: payload.source,
        dumpId,
        questId: q.id,
        chapter: q.chapter,
        chapterTitle: resolveLang(lang, q.chapterTitle),
        title: resolveLang(lang, q.title),
        subtitle: resolveLang(lang, q.subtitle),
        taskCount: q.taskCount,
        tasks: q.tasks,
        dumpedAt,
      }));
      if (docs.length > 0) {
        try {
          // ordered:false — one duplicate questId in a malformed dump skips that row, not the rest
          await col().insertMany(docs, { ordered: false });
        } catch (err) {
          if (!isDuplicateKeyOnly(err)) {
            // Unknown partial state: discard this generation, the previous one stays active.
            await col().deleteMany({ instanceKey: identity.instanceKey, dumpId });
            throw err;
          }
          logger.warn({ instanceKey: identity.instanceKey }, 'biforesting-questreg: duplicate questIds in dump — kept first occurrence of each');
        }
      }
      const count = await col().countDocuments({ instanceKey: identity.instanceKey, dumpId });
      await setActiveGeneration(dbProvider(), 'quest', identity.instanceKey, {
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
      { err, instanceKey: identity.instanceKey, count: payload.quests.length },
      'biforesting-questreg: dump persist failed (previous registry generation kept)',
    );
  }
}

/** Registry meta for an instance: how many quests, from which mod, dumped when. */
export async function questRegistryInfo(instanceKey: string): Promise<{ count: number; source: string | null; dumpedAt: Date | null }> {
  const gen = await getActiveGeneration(dbProvider(), 'quest', instanceKey);
  if (!gen) return { count: 0, source: null, dumpedAt: null };
  return { count: gen.count, source: gen.source, dumpedAt: gen.dumpedAt };
}

/**
 * Search quests by free text. Resolution order: exact questId hit → $text (stemmed words,
 * relevance-sorted) → case-insensitive substring regex (partial words — a few thousand docs
 * per instance, the scan is trivial). No search string lists the registry in chapter order.
 */
export async function searchQuests(instanceKey: string, search: string | undefined, limit = 20): Promise<QuestRegistryDoc[]> {
  await ensureQuestRegIndexes();
  const base = await activeFilter(instanceKey);
  if (!base) return [];
  const q = search?.trim();
  if (!q) {
    return col().find(base).sort({ chapter: 1, questId: 1 }).limit(limit).toArray();
  }
  const byId = await col().find({ ...base, questId: q }).limit(1).toArray();
  if (byId.length > 0) return byId;
  const text = await col()
    .find({ ...base, $text: { $search: q } }, { projection: { score: { $meta: 'textScore' } } })
    .sort({ score: { $meta: 'textScore' } })
    .limit(limit)
    .toArray();
  if (text.length > 0) return text;
  const rx = new RegExp(escapeRegex(q), 'i');
  return col()
    .find({ ...base, $or: [{ title: rx }, { subtitle: rx }, { chapterTitle: rx }] })
    .limit(limit)
    .toArray();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
