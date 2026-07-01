import type { Collection, Db } from 'mongodb';
import { getDb } from '../../core/database/client.js';
import { logger } from '../../core/logger/index.js';

/**
 * Per-server link feature policy, keyed by instanceKey — the authoritative source for what a
 * backend's biforesting mod is allowed to run. The mod defaults everything OFF; `reg_ack`
 * carries this policy, and PUTs re-send it to a live session (live kill switch, no redeploy).
 *
 * Unknown servers get {@link ZERO_POLICY} (nothing enabled) — a new backend is observed but
 * inert until an admin grants bits.
 */

export interface LinkPolicyDoc {
  instanceKey: string;
  enabledFeatures: number;
  metricsHz: number;
  questHz: number;
  chunkHz: number;
  updatedAt?: Date;
  updatedBy?: string;
}

export const ZERO_POLICY: Omit<LinkPolicyDoc, 'instanceKey'> = {
  enabledFeatures: 0,
  metricsHz: 0,
  questHz: 0,
  chunkHz: 0,
};

/**
 * Feature name → capability bit. MUST mirror the mod's shared
 * `PlayProtocol.featureBitsByName()` (bifrost-lib `shared/wire/PlayProtocol.java`).
 */
export const FEATURE_BITS: Record<string, number> = {
  play_transport: 0x10,
  metrics: 0x20,
  registry: 0x40,
  inventory_sync: 0x80,
  quest_sync: 0x100,
  chunk_sync: 0x200,
  ops: 0x400,
  presence: 0x800,
  inv_snapshot: 0x1000,
  player_ops: 0x2000,
  offline_edit: 0x4000,
  quest_ops: 0x8000,
  team_ops: 0x10000,
};

export function maskForFeatures(names: string[]): number {
  let mask = 0;
  for (const n of names) {
    const bit = FEATURE_BITS[n.toLowerCase()];
    if (bit !== undefined) mask |= bit;
  }
  return mask;
}

export function featureNamesForMask(mask: number): string[] {
  return Object.entries(FEATURE_BITS)
    .filter(([, bit]) => (mask & bit) !== 0)
    .map(([name]) => name);
}

function db(): Db {
  return getDb();
}

function policiesCol(): Collection<LinkPolicyDoc> {
  return db().collection<LinkPolicyDoc>('biforesting_policies');
}

let indexEnsured = false;

async function ensureIndex(): Promise<void> {
  if (indexEnsured) return;
  try {
    await policiesCol().createIndex({ instanceKey: 1 }, { unique: true });
    indexEnsured = true;
  } catch (err) {
    logger.warn({ err }, 'biforesting-link: failed to ensure biforesting_policies index');
  }
}

/** Fail-soft: any DB problem yields ZERO_POLICY (features stay off — never fail open). */
export async function getPolicy(instanceKey: string): Promise<Omit<LinkPolicyDoc, 'instanceKey'>> {
  try {
    await ensureIndex();
    const doc = await policiesCol().findOne({ instanceKey });
    if (!doc) return ZERO_POLICY;
    return {
      enabledFeatures: doc.enabledFeatures ?? 0,
      metricsHz: doc.metricsHz ?? 0,
      questHz: doc.questHz ?? 0,
      chunkHz: doc.chunkHz ?? 0,
    };
  } catch (err) {
    logger.warn({ err, instanceKey }, 'biforesting-link: policy lookup failed — using ZERO policy');
    return ZERO_POLICY;
  }
}

export async function setPolicy(
  instanceKey: string,
  fields: Partial<Omit<LinkPolicyDoc, 'instanceKey' | 'updatedAt' | 'updatedBy'>>,
  updatedBy: string,
): Promise<LinkPolicyDoc> {
  await ensureIndex();
  const update = {
    $set: { ...fields, updatedAt: new Date(), updatedBy },
    $setOnInsert: {
      instanceKey,
      ...Object.fromEntries(Object.entries(ZERO_POLICY).filter(([k]) => !(k in fields))),
    },
  };
  await policiesCol().updateOne({ instanceKey }, update, { upsert: true });
  const doc = await policiesCol().findOne({ instanceKey });
  if (!doc) throw new Error('policy upsert failed');
  return doc;
}
