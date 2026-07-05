import type { Collection, Db } from 'mongodb';
import { getDb } from '../../core/database/client.js';
import { logger } from '../../core/logger/index.js';
import type { LinkIdentity, QuestRegPayload } from './types.js';

/**
 * Quest registry (phase 6): one doc per quest per instanceKey, replaced wholesale on every
 * `biforesting:questreg` dump — the dump is authoritative, so quests removed from the pack
 * disappear here too. The text index over title/subtitle/chapterTitle powers the
 * "I don't know the quest ID" search endpoint; ids stay opaque strings (FTBQ hex / BQ int).
 */

export interface QuestRegistryDoc {
  instanceKey: string;
  tag: string | null;
  serverId: string | null;
  source: string;
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
  await col().createIndex({ instanceKey: 1, questId: 1 }, { unique: true });
  await col().createIndex({ title: 'text', subtitle: 'text', chapterTitle: 'text' });
  indexesEnsured = true;
}

/** Replace the instance's whole registry with this dump (delete + insert, dump-authoritative). */
export async function saveQuestRegistry(identity: LinkIdentity, payload: QuestRegPayload): Promise<void> {
  try {
    await ensureQuestRegIndexes();
    const dumpedAt = new Date();
    const docs: QuestRegistryDoc[] = payload.quests.map((q) => ({
      instanceKey: identity.instanceKey,
      tag: identity.tag,
      serverId: identity.serverId,
      source: payload.source,
      questId: q.id,
      chapter: q.chapter,
      chapterTitle: q.chapterTitle,
      title: q.title,
      subtitle: q.subtitle,
      taskCount: q.taskCount,
      tasks: q.tasks,
      dumpedAt,
    }));
    await col().deleteMany({ instanceKey: identity.instanceKey });
    if (docs.length > 0) {
      // ordered:false — one duplicate questId in a malformed dump skips that row, not the rest
      await col().insertMany(docs, { ordered: false });
    }
  } catch (err) {
    logger.warn({ err, instanceKey: identity.instanceKey, count: payload.quests.length }, 'biforesting-questreg: dump persist failed');
  }
}

/** Registry meta for an instance: how many quests, from which mod, dumped when. */
export async function questRegistryInfo(instanceKey: string): Promise<{ count: number; source: string | null; dumpedAt: Date | null }> {
  await ensureQuestRegIndexes();
  const newest = await col().find({ instanceKey }).sort({ dumpedAt: -1 }).limit(1).next();
  if (!newest) return { count: 0, source: null, dumpedAt: null };
  const count = await col().countDocuments({ instanceKey });
  return { count, source: newest.source, dumpedAt: newest.dumpedAt };
}

/**
 * Search quests by free text. Resolution order: exact questId hit → $text (stemmed words,
 * relevance-sorted) → case-insensitive substring regex (partial words — a few thousand docs
 * per instance, the scan is trivial). No search string lists the registry in chapter order.
 */
export async function searchQuests(instanceKey: string, search: string | undefined, limit = 20): Promise<QuestRegistryDoc[]> {
  await ensureQuestRegIndexes();
  const q = search?.trim();
  if (!q) {
    return col().find({ instanceKey }).sort({ chapter: 1, questId: 1 }).limit(limit).toArray();
  }
  const byId = await col().find({ instanceKey, questId: q }).limit(1).toArray();
  if (byId.length > 0) return byId;
  const text = await col()
    .find({ instanceKey, $text: { $search: q } }, { projection: { score: { $meta: 'textScore' } } })
    .sort({ score: { $meta: 'textScore' } })
    .limit(limit)
    .toArray();
  if (text.length > 0) return text;
  const rx = new RegExp(escapeRegex(q), 'i');
  return col()
    .find({ instanceKey, $or: [{ title: rx }, { subtitle: rx }, { chapterTitle: rx }] })
    .limit(limit)
    .toArray();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
