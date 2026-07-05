import type { Collection, Db } from 'mongodb';
import { getDb } from '../../core/database/client.js';
import { logger } from '../../core/logger/index.js';
import type { LinkIdentity, LinkMetrics } from './types.js';

/**
 * Metrics history (plan D13): every accepted `biforesting:metrics` payload lands in
 * `biforesting_metrics` (raw, TTL 72 h) and an hourly downsample cron folds finished hours
 * into `biforesting_metrics_hourly` (TTL 30 d). New collections — `server_stats_history`
 * consumers are untouched. Writes are best-effort; failures log, never throw into the
 * socket handler.
 */

export interface MetricsRawDoc {
  instanceKey: string;
  tag: string | null;
  serverId: string | null;
  at: Date;
  metrics: LinkMetrics;
}

export interface MetricsHourlyDoc {
  instanceKey: string;
  hour: Date;
  samples: number;
  msptAvg: number;
  msptMax: number;
  tpsAvg: number;
  tpsMin: number;
  playersAvg: number;
  playersMax: number;
  heapUsedAvg: number;
  loadedChunksAvg: number;
}

const RAW_TTL_SECONDS = 72 * 3600;
const HOURLY_TTL_SECONDS = 30 * 24 * 3600;
/** The cron runs every few minutes but only the previous FULL hour is folded (idempotent upsert). */
export const DOWNSAMPLE_SWEEP_MS = 5 * 60_000;

let dbProvider: () => Db = getDb;

/** Test seam — mirror of policy-store's. */
export function setMetricsDbProvider(provider: () => Db): void {
  dbProvider = provider;
  indexesEnsured = false;
}

function rawCol(): Collection<MetricsRawDoc> {
  return dbProvider().collection<MetricsRawDoc>('biforesting_metrics');
}
function hourlyCol(): Collection<MetricsHourlyDoc> {
  return dbProvider().collection<MetricsHourlyDoc>('biforesting_metrics_hourly');
}

let indexesEnsured = false;

export async function ensureMetricsIndexes(): Promise<void> {
  if (indexesEnsured) return;
  await rawCol().createIndex({ instanceKey: 1, at: -1 });
  await rawCol().createIndex({ at: 1 }, { expireAfterSeconds: RAW_TTL_SECONDS });
  await hourlyCol().createIndex({ instanceKey: 1, hour: -1 }, { unique: true });
  await hourlyCol().createIndex({ hour: 1 }, { expireAfterSeconds: HOURLY_TTL_SECONDS });
  indexesEnsured = true;
}

/** Insert one raw sample (called from the link manager on every accepted metrics frame). */
export async function saveMetrics(identity: LinkIdentity, metrics: LinkMetrics): Promise<void> {
  try {
    await ensureMetricsIndexes();
    await rawCol().insertOne({
      instanceKey: identity.instanceKey,
      tag: identity.tag,
      serverId: identity.serverId,
      at: new Date(),
      metrics,
    });
  } catch (err) {
    logger.warn({ err, instanceKey: identity.instanceKey }, 'biforesting-metrics: raw insert failed');
  }
}

/** Truncate a date to its hour start (UTC). */
export function hourStart(d: Date): Date {
  const h = new Date(d);
  h.setUTCMinutes(0, 0, 0);
  return h;
}

/**
 * Fold one hour of raw samples into per-instance hourly docs. Idempotent (upsert by
 * instanceKey+hour) — safe to re-run for the same hour. Returns the number of instances folded.
 */
export async function downsampleHour(hour: Date): Promise<number> {
  await ensureMetricsIndexes();
  const from = hourStart(hour);
  const to = new Date(from.getTime() + 3600_000);
  const groups = await rawCol()
    .aggregate<{
      _id: string;
      samples: number;
      msptAvg: number;
      msptMax: number;
      tpsAvg: number;
      tpsMin: number;
      playersAvg: number;
      playersMax: number;
      heapUsedAvg: number;
      loadedChunksAvg: number;
    }>([
      { $match: { at: { $gte: from, $lt: to } } },
      {
        $group: {
          _id: '$instanceKey',
          samples: { $sum: 1 },
          msptAvg: { $avg: '$metrics.mspt' },
          msptMax: { $max: { $ifNull: ['$metrics.msptMax', '$metrics.mspt'] } },
          tpsAvg: { $avg: '$metrics.tps' },
          tpsMin: { $min: '$metrics.tps' },
          playersAvg: { $avg: '$metrics.players' },
          playersMax: { $max: '$metrics.players' },
          heapUsedAvg: { $avg: '$metrics.heapUsed' },
          loadedChunksAvg: { $avg: '$metrics.loadedChunks' },
        },
      },
    ])
    .toArray();
  for (const g of groups) {
    const { _id, ...fields } = g;
    await hourlyCol().updateOne({ instanceKey: _id, hour: from }, { $set: fields }, { upsert: true });
  }
  return groups.length;
}

/** Periodic sweep: fold the previous full hour. Returns a stop function. */
export function startDownsampleSweep(): () => void {
  const timer = setInterval(() => {
    const prevHour = hourStart(new Date(Date.now() - 3600_000));
    void downsampleHour(prevHour).catch((err) =>
      logger.warn({ err }, 'biforesting-metrics: downsample sweep failed'),
    );
  }, DOWNSAMPLE_SWEEP_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** Most recent stored raw sample for an instance (fallback when no live session). */
export async function latestStored(instanceKey: string): Promise<MetricsRawDoc | null> {
  await ensureMetricsIndexes();
  return rawCol().findOne({ instanceKey }, { sort: { at: -1 } });
}

export async function rawHistory(instanceKey: string, sinceHours: number): Promise<MetricsRawDoc[]> {
  await ensureMetricsIndexes();
  const since = new Date(Date.now() - sinceHours * 3600_000);
  return rawCol()
    .find({ instanceKey, at: { $gte: since } })
    .sort({ at: 1 })
    .toArray();
}

export async function hourlyHistory(instanceKey: string, sinceHours: number): Promise<MetricsHourlyDoc[]> {
  await ensureMetricsIndexes();
  const since = new Date(Date.now() - sinceHours * 3600_000);
  return hourlyCol()
    .find({ instanceKey, hour: { $gte: since } })
    .sort({ hour: 1 })
    .toArray();
}
