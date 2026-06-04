import type { Collection, Db } from 'mongodb';
import { getDb } from '../../core/database/client.js';
import { logger } from '../../core/logger/index.js';
import type { LinkIdentity, RegistryPayload, QuestTeam, ChunkTeam } from './types.js';

/**
 * Persists link UP data into Yggdrasil-owned collections (the configured `MONGODB_DB_NAME` DB):
 *   - `biforesting_registry`  — one doc per instanceKey (item id → numericId map)
 *   - `biforesting_quests`    — one doc per (instanceKey, teamId)
 *   - `biforesting_chunks`    — one doc per (instanceKey, teamId)
 * All writes are best-effort; failures are logged, never thrown into the socket handler.
 */

interface IdentityFields {
  instanceKey: string;
  tag: string | null;
  serverId: string | null;
}

let indexesEnsured = false;

function db(): Db {
  return getDb();
}

function registryCol(): Collection {
  return db().collection('biforesting_registry');
}
function questsCol(): Collection {
  return db().collection('biforesting_quests');
}
function chunksCol(): Collection {
  return db().collection('biforesting_chunks');
}

export async function ensureIndexes(): Promise<void> {
  if (indexesEnsured) return;
  try {
    await registryCol().createIndex({ instanceKey: 1 }, { unique: true });
    await questsCol().createIndex({ instanceKey: 1, teamId: 1 }, { unique: true });
    await chunksCol().createIndex({ instanceKey: 1, teamId: 1 }, { unique: true });
    indexesEnsured = true;
  } catch (err) {
    logger.warn({ err }, 'biforesting-link: failed to ensure indexes');
  }
}

function idFields(identity: LinkIdentity): IdentityFields {
  return { instanceKey: identity.instanceKey, tag: identity.tag, serverId: identity.serverId };
}

export async function saveRegistry(identity: LinkIdentity, payload: RegistryPayload): Promise<void> {
  try {
    await registryCol().updateOne(
      { instanceKey: identity.instanceKey },
      { $set: { ...idFields(identity), count: payload.count, entries: payload.entries, updatedAt: new Date() } },
      { upsert: true },
    );
  } catch (err) {
    logger.error({ err, instanceKey: identity.instanceKey }, 'biforesting-link: failed to persist registry');
  }
}

export async function saveQuests(identity: LinkIdentity, teams: QuestTeam[]): Promise<void> {
  if (teams.length === 0) return;
  try {
    const now = new Date();
    const ops = teams.map((t) => ({
      updateOne: {
        filter: { instanceKey: identity.instanceKey, teamId: t.teamId },
        update: { $set: { ...idFields(identity), teamId: t.teamId, dataVersion: t.dataVersion, snbt: t.snbt, updatedAt: now } },
        upsert: true,
      },
    }));
    await questsCol().bulkWrite(ops, { ordered: false });
  } catch (err) {
    logger.error({ err, instanceKey: identity.instanceKey }, 'biforesting-link: failed to persist quests');
  }
}

export async function saveChunks(identity: LinkIdentity, teams: ChunkTeam[]): Promise<void> {
  if (teams.length === 0) return;
  try {
    const now = new Date();
    const ops = teams.map((t) => ({
      updateOne: {
        filter: { instanceKey: identity.instanceKey, teamId: t.teamId },
        update: { $set: { ...idFields(identity), teamId: t.teamId, claims: t.claims, updatedAt: now } },
        upsert: true,
      },
    }));
    await chunksCol().bulkWrite(ops, { ordered: false });
  } catch (err) {
    logger.error({ err, instanceKey: identity.instanceKey }, 'biforesting-link: failed to persist chunks');
  }
}
