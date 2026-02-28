import type { Collection, WithId } from 'mongodb';
import { getClient, getDb } from '../../core/database/client.js';
import type { PlayerDocument, PlayerHistoryDocument, PlayerSessionDocument, PeakRecord } from './players.types.js';

const DB_NAME = 'valhallamc';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function pickBucket(rangeMs: number): { unit: 'minute' | 'hour' | 'day'; binSize: number } | null {
  const hours = rangeMs / HOUR;
  if (hours <= 2) return null;
  if (hours <= 12) return { unit: 'minute', binSize: 5 };
  if (hours <= 48) return { unit: 'minute', binSize: 15 };
  if (hours <= 168) return { unit: 'hour', binSize: 1 };
  if (hours <= 720) return { unit: 'hour', binSize: 4 };
  if (hours <= 2160) return { unit: 'hour', binSize: 12 };
  return { unit: 'day', binSize: 1 };
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY);
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export class PlayersRepository {
  private _players?: Collection<PlayerDocument>;
  private _history?: Collection<PlayerHistoryDocument>;
  private _sessions?: Collection<PlayerSessionDocument>;

  private get players(): Collection<PlayerDocument> {
    this._players ??= getClient().db(DB_NAME).collection<PlayerDocument>('players');
    return this._players;
  }

  get history(): Collection<PlayerHistoryDocument> {
    this._history ??= getDb().collection<PlayerHistoryDocument>('player_stats_history');
    return this._history;
  }

  get sessions(): Collection<PlayerSessionDocument> {
    this._sessions ??= getDb().collection<PlayerSessionDocument>('player_sessions');
    return this._sessions;
  }

  // ── Player Lookups ────────────────────────────────────────────────────

  async findByUsername(username: string): Promise<WithId<PlayerDocument> | null> {
    return this.players.findOne({ username: { $regex: new RegExp(`^${escapeRegex(username)}$`, 'i') } });
  }

  async searchByUsername(query: string, limit: number): Promise<WithId<PlayerDocument>[]> {
    return this.players
      .find({ username: { $regex: new RegExp(escapeRegex(query), 'i') } })
      .limit(limit)
      .toArray();
  }

  // ── Leaderboards ──────────────────────────────────────────────────────

  async findTopByPlaytime(limit: number, tag?: string): Promise<WithId<PlayerDocument>[]> {
    if (tag) {
      return this.players
        .find({ [`playtime.${tag}`]: { $exists: true } })
        .sort({ [`playtime.${tag}`]: -1 })
        .limit(limit)
        .toArray();
    }

    return this.players
      .aggregate<WithId<PlayerDocument>>([
        {
          $addFields: {
            totalPlaytime: {
              $reduce: {
                input: { $objectToArray: '$playtime' },
                initialValue: 0,
                in: { $add: ['$$value', '$$this.v'] },
              },
            },
          },
        },
        { $sort: { totalPlaytime: -1 } },
        { $limit: limit },
        { $project: { totalPlaytime: 0 } },
      ])
      .toArray();
  }

  async findTopByFirstSeen(limit: number): Promise<WithId<PlayerDocument>[]> {
    return this.players
      .aggregate<WithId<PlayerDocument>>([
        {
          $addFields: {
            _earliestSeen: {
              $min: { $map: { input: { $objectToArray: '$first_seen' }, as: 'e', in: '$$e.v' } },
            },
          },
        },
        { $sort: { _earliestSeen: 1 } },
        { $limit: limit },
        { $project: { _earliestSeen: 0 } },
      ])
      .toArray();
  }

  // ── History ───────────────────────────────────────────────────────────

  async findPlayerHistory(from: Date, to: Date, server?: string): Promise<PlayerHistoryDocument[]> {
    const source = server ?? 'global';
    const bucket = pickBucket(to.getTime() - from.getTime());

    if (!bucket) {
      return this.history
        .find({ source, timestamp: { $gte: from, $lte: to } })
        .sort({ timestamp: 1 })
        .toArray();
    }

    return this.history
      .aggregate<PlayerHistoryDocument>([
        { $match: { source, timestamp: { $gte: from, $lte: to } } },
        { $sort: { timestamp: 1 } },
        {
          $group: {
            _id: { $dateTrunc: { date: '$timestamp', unit: bucket.unit, binSize: bucket.binSize } },
            source: { $first: '$source' },
            playerCount: { $max: '$playerCount' },
            peakPlayerCount: { $max: { $ifNull: ['$peakPlayerCount', '$playerCount'] } },
            avgLatencyP95: { $avg: '$avgLatencyP95' },
            avgLatencyAvg: { $avg: '$avgLatencyAvg' },
          },
        },
        { $sort: { _id: 1 } },
        {
          $project: {
            _id: 0,
            timestamp: '$_id',
            source: 1,
            playerCount: 1,
            peakPlayerCount: 1,
            avgLatencyP95: { $round: ['$avgLatencyP95', 2] },
            avgLatencyAvg: { $round: ['$avgLatencyAvg', 2] },
          },
        },
      ])
      .toArray();
  }

  // ── Analytics ─────────────────────────────────────────────────────────

  async findAllTimePeak(server?: string): Promise<PeakRecord | null> {
    const source = server ?? 'global';
    const result = await this.history
      .aggregate<{ count: number; timestamp: Date }>([
        { $match: { source } },
        {
          $addFields: {
            _peak: { $ifNull: ['$peakPlayerCount', '$playerCount'] },
          },
        },
        { $sort: { _peak: -1 } },
        { $limit: 1 },
        { $project: { _id: 0, count: '$_peak', timestamp: 1 } },
      ])
      .toArray();
    return result[0] ?? null;
  }

  async getPopulationStats(server?: string): Promise<{ totalUniquePlayers: number; totalPlaytimeMs: number; avgPlaytimeMs: number }> {
    if (server) {
      const result = await this.players
        .aggregate<{ totalUniquePlayers: number; totalPlaytimeMs: number; avgPlaytimeMs: number }>([
          { $match: { [`first_seen.${server}`]: { $exists: true } } },
          {
            $group: {
              _id: null,
              totalUniquePlayers: { $sum: 1 },
              totalPlaytimeMs: { $sum: { $multiply: [{ $ifNull: [`$playtime.${server}`, 0] }, 60_000] } },
            },
          },
          {
            $project: {
              _id: 0,
              totalUniquePlayers: 1,
              totalPlaytimeMs: 1,
              avgPlaytimeMs: {
                $cond: [{ $gt: ['$totalUniquePlayers', 0] }, { $round: [{ $divide: ['$totalPlaytimeMs', '$totalUniquePlayers'] }, 0] }, 0],
              },
            },
          },
        ])
        .toArray();
      return result[0] ?? { totalUniquePlayers: 0, totalPlaytimeMs: 0, avgPlaytimeMs: 0 };
    }

    const result = await this.players
      .aggregate<{ totalUniquePlayers: number; totalPlaytimeMs: number; avgPlaytimeMs: number }>([
        {
          $addFields: {
            _totalPt: {
              $reduce: {
                input: { $objectToArray: '$playtime' },
                initialValue: 0,
                in: { $add: ['$$value', '$$this.v'] },
              },
            },
          },
        },
        {
          $group: {
            _id: null,
            totalUniquePlayers: { $sum: 1 },
            totalPlaytimeMs: { $sum: { $multiply: ['$_totalPt', 60_000] } },
          },
        },
        {
          $project: {
            _id: 0,
            totalUniquePlayers: 1,
            totalPlaytimeMs: 1,
            avgPlaytimeMs: {
              $cond: [{ $gt: ['$totalUniquePlayers', 0] }, { $round: [{ $divide: ['$totalPlaytimeMs', '$totalUniquePlayers'] }, 0] }, 0],
            },
          },
        },
      ])
      .toArray();
    return result[0] ?? { totalUniquePlayers: 0, totalPlaytimeMs: 0, avgPlaytimeMs: 0 };
  }

  async getNewPlayerCounts(server?: string): Promise<{ today: number; last7Days: number; last30Days: number }> {
    const todayCutoff = startOfDay(new Date());
    const sevenDaysAgo = daysAgo(7);
    const thirtyDaysAgo = daysAgo(30);

    const addEarliestSeen = server
      ? [{ $match: { [`first_seen.${server}`]: { $exists: true } } }, { $addFields: { _earliest: `$first_seen.${server}` } }]
      : [
          {
            $addFields: {
              _earliest: {
                $min: { $map: { input: { $objectToArray: '$first_seen' }, as: 'e', in: '$$e.v' } },
              },
            },
          },
        ];

    const result = await this.players
      .aggregate<{ today: number; last7Days: number; last30Days: number }>([
        ...addEarliestSeen,
        {
          $facet: {
            today: [{ $match: { _earliest: { $gte: todayCutoff } } }, { $count: 'c' }],
            last7Days: [{ $match: { _earliest: { $gte: sevenDaysAgo } } }, { $count: 'c' }],
            last30Days: [{ $match: { _earliest: { $gte: thirtyDaysAgo } } }, { $count: 'c' }],
          },
        },
        {
          $project: {
            today: { $ifNull: [{ $arrayElemAt: ['$today.c', 0] }, 0] },
            last7Days: { $ifNull: [{ $arrayElemAt: ['$last7Days.c', 0] }, 0] },
            last30Days: { $ifNull: [{ $arrayElemAt: ['$last30Days.c', 0] }, 0] },
          },
        },
      ])
      .toArray();
    return result[0] ?? { today: 0, last7Days: 0, last30Days: 0 };
  }

  async getUniqueActivePlayers(server?: string): Promise<{ today: number; last7Days: number; last30Days: number }> {
    const todayCutoff = startOfDay(new Date());
    const sevenDaysAgo = daysAgo(7);
    const thirtyDaysAgo = daysAgo(30);

    const serverMatch = server ? { server } : {};

    const result = await this.sessions
      .aggregate<{ today: number; last7Days: number; last30Days: number }>([
        { $match: { ...serverMatch, joinedAt: { $gte: thirtyDaysAgo } } },
        {
          $facet: {
            today: [{ $match: { joinedAt: { $gte: todayCutoff } } }, { $group: { _id: '$username' } }, { $count: 'c' }],
            last7Days: [{ $match: { joinedAt: { $gte: sevenDaysAgo } } }, { $group: { _id: '$username' } }, { $count: 'c' }],
            last30Days: [{ $group: { _id: '$username' } }, { $count: 'c' }],
          },
        },
        {
          $project: {
            today: { $ifNull: [{ $arrayElemAt: ['$today.c', 0] }, 0] },
            last7Days: { $ifNull: [{ $arrayElemAt: ['$last7Days.c', 0] }, 0] },
            last30Days: { $ifNull: [{ $arrayElemAt: ['$last30Days.c', 0] }, 0] },
          },
        },
      ])
      .toArray();
    return result[0] ?? { today: 0, last7Days: 0, last30Days: 0 };
  }

  async getSessionStats(server?: string): Promise<{ totalCount: number; avgDurationMs: number }> {
    const match: Record<string, unknown> = { leftAt: { $ne: null } };
    if (server) match['server'] = server;

    const result = await this.sessions
      .aggregate<{ totalCount: number; avgDurationMs: number }>([
        { $match: match },
        {
          $group: {
            _id: null,
            totalCount: { $sum: 1 },
            avgDurationMs: { $avg: '$duration' },
          },
        },
        {
          $project: {
            _id: 0,
            totalCount: 1,
            avgDurationMs: { $round: ['$avgDurationMs', 0] },
          },
        },
      ])
      .toArray();
    return result[0] ?? { totalCount: 0, avgDurationMs: 0 };
  }

  async getPlayerClassification(server?: string): Promise<{ regulars: number; newRegulars: number; inactive: number; returning: number }> {
    const [regulars, previousRegulars, inactive, returning] = await Promise.all([
      this.countRegulars(14, server),
      this.countRegulars(14, server, daysAgo(7)),
      this.countInactive(server),
      this.countReturning(server),
    ]);

    return {
      regulars,
      newRegulars: Math.max(0, regulars - previousRegulars),
      inactive,
      returning,
    };
  }

  /** Count players with 3+ unique active days within `windowDays` days before `before`. */
  private async countRegulars(windowDays: number, server?: string, before?: Date): Promise<number> {
    const end = before ?? new Date();
    const start = new Date(end.getTime() - windowDays * DAY);
    const match: Record<string, unknown> = { joinedAt: { $gte: start, $lt: end } };
    if (server) match['server'] = server;

    const result = await this.sessions
      .aggregate<{ count: number }>([
        { $match: match },
        {
          $group: {
            _id: {
              username: '$username',
              day: { $dateTrunc: { date: '$joinedAt', unit: 'day' } },
            },
          },
        },
        { $group: { _id: '$_id.username', uniqueDays: { $sum: 1 } } },
        { $match: { uniqueDays: { $gte: 3 } } },
        { $count: 'count' },
      ])
      .toArray();
    return result[0]?.count ?? 0;
  }

  /** Count players not seen in 30+ days who had prior activity. */
  private async countInactive(server?: string): Promise<number> {
    const cutoff = daysAgo(30);

    if (server) {
      const result = await this.players
        .aggregate<{ count: number }>([
          {
            $match: {
              [`first_seen.${server}`]: { $exists: true },
              $or: [
                { [`leave_dates.${server}`]: { $lt: cutoff } },
                { [`leave_dates.${server}`]: { $exists: false }, [`first_seen.${server}`]: { $lt: cutoff } },
              ],
            },
          },
          { $count: 'count' },
        ])
        .toArray();
      return result[0]?.count ?? 0;
    }

    const result = await this.players
      .aggregate<{ count: number }>([
        {
          $addFields: {
            _latestLeave: {
              $max: { $map: { input: { $objectToArray: { $ifNull: ['$leave_dates', {}] } }, as: 'e', in: '$$e.v' } },
            },
            _earliestSeen: {
              $min: { $map: { input: { $objectToArray: '$first_seen' }, as: 'e', in: '$$e.v' } },
            },
          },
        },
        {
          $match: {
            $or: [
              { _latestLeave: { $lt: cutoff } },
              { _latestLeave: null, _earliestSeen: { $lt: cutoff } },
            ],
          },
        },
        { $count: 'count' },
      ])
      .toArray();
    return result[0]?.count ?? 0;
  }

  /** Count players who returned after being inactive for 30+ days (had a session gap >= 30 days). */
  private async countReturning(server?: string): Promise<number> {
    const match: Record<string, unknown> = { leftAt: { $ne: null } };
    if (server) match['server'] = server;

    const result = await this.sessions
      .aggregate<{ count: number }>([
        { $match: match },
        { $sort: { username: 1, joinedAt: 1 } },
        {
          $setWindowFields: {
            partitionBy: '$username',
            sortBy: { joinedAt: 1 },
            output: { _prevLeftAt: { $shift: { output: '$leftAt', by: -1, default: null } } },
          },
        },
        {
          $match: {
            _prevLeftAt: { $ne: null },
            $expr: { $gte: [{ $subtract: ['$joinedAt', '$_prevLeftAt'] }, 30 * DAY] },
          },
        },
        { $group: { _id: '$username' } },
        { $count: 'count' },
      ])
      .toArray();
    return result[0]?.count ?? 0;
  }

  async getWeeklyGrowth(weeks: number, server?: string): Promise<Array<{ week: string; newPlayers: number }>> {
    const cutoff = daysAgo(weeks * 7);

    const addEarliestSeen = server
      ? [{ $match: { [`first_seen.${server}`]: { $exists: true, $gte: cutoff } } }, { $addFields: { _earliest: `$first_seen.${server}` } }]
      : [
          {
            $addFields: {
              _earliest: {
                $min: { $map: { input: { $objectToArray: '$first_seen' }, as: 'e', in: '$$e.v' } },
              },
            },
          },
          { $match: { _earliest: { $gte: cutoff } } },
        ];

    return this.players
      .aggregate<{ week: string; newPlayers: number }>([
        ...addEarliestSeen,
        {
          $group: {
            _id: { $dateToString: { format: '%G-W%V', date: '$_earliest' } },
            newPlayers: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
        { $project: { _id: 0, week: '$_id', newPlayers: 1 } },
      ])
      .toArray();
  }

  async getRetentionCohorts(
    weeks: number,
    server?: string,
  ): Promise<Array<{ cohort: string; cohortSize: number; weeks: Array<{ week: number; returned: number; rate: number }> }>> {
    const cutoff = daysAgo(weeks * 7);

    // Stage 1: Get cohort membership from players collection
    const addEarliestSeen = server
      ? [{ $match: { [`first_seen.${server}`]: { $exists: true, $gte: cutoff } } }, { $addFields: { _earliest: `$first_seen.${server}` } }]
      : [
          {
            $addFields: {
              _earliest: {
                $min: { $map: { input: { $objectToArray: '$first_seen' }, as: 'e', in: '$$e.v' } },
              },
            },
          },
          { $match: { _earliest: { $gte: cutoff } } },
        ];

    const cohortMembers = await this.players
      .aggregate<{ week: string; username: string; earliest: Date }>([
        ...addEarliestSeen,
        {
          $project: {
            _id: 0,
            username: 1,
            week: { $dateToString: { format: '%G-W%V', date: '$_earliest' } },
            earliest: '$_earliest',
          },
        },
      ])
      .toArray();

    // Group by cohort week
    const cohortMap = new Map<string, { usernames: Set<string>; earliest: Date }>();
    for (const m of cohortMembers) {
      let entry = cohortMap.get(m.week);
      if (!entry) {
        entry = { usernames: new Set(), earliest: m.earliest };
        cohortMap.set(m.week, entry);
      }
      entry.usernames.add(m.username);
      if (m.earliest < entry.earliest) entry.earliest = m.earliest;
    }

    const cohorts = Array.from(cohortMap.entries()).sort(([a], [b]) => a.localeCompare(b));
    const results: Array<{ cohort: string; cohortSize: number; weeks: Array<{ week: number; returned: number; rate: number }> }> = [];

    // Stage 2: For each cohort, one query computes all follow-up weeks at once
    const serverMatch = server ? { server } : {};

    await Promise.all(
      cohorts.map(async ([cohortWeek, { usernames, earliest }]) => {
        if (usernames.size === 0) return;

        const usernameArr = Array.from(usernames);
        const maxFollowUp = Math.min(weeks - 1, Math.floor((Date.now() - earliest.getTime()) / (7 * DAY)));
        if (maxFollowUp < 1) {
          results.push({ cohort: cohortWeek, cohortSize: usernames.size, weeks: [] });
          return;
        }

        const rangeStart = new Date(earliest.getTime() + 7 * DAY);
        const rangeEnd = new Date(earliest.getTime() + (maxFollowUp + 1) * 7 * DAY);

        const weekCounts = await this.sessions
          .aggregate<{ _id: number; count: number }>([
            { $match: { ...serverMatch, username: { $in: usernameArr }, joinedAt: { $gte: rangeStart, $lt: rangeEnd } } },
            { $addFields: { _weekOffset: { $floor: { $divide: [{ $subtract: ['$joinedAt', earliest] }, 7 * DAY] } } } },
            { $group: { _id: { week: '$_weekOffset', username: '$username' } } },
            { $group: { _id: '$_id.week', count: { $sum: 1 } } },
          ])
          .toArray();

        const countByWeek = new Map(weekCounts.map((r) => [r._id, r.count]));
        const weekResults: Array<{ week: number; returned: number; rate: number }> = [];
        for (let w = 1; w <= maxFollowUp; w++) {
          const count = countByWeek.get(w) ?? 0;
          weekResults.push({ week: w, returned: count, rate: Math.round((count / usernames.size) * 1000) / 1000 });
        }

        results.push({ cohort: cohortWeek, cohortSize: usernames.size, weeks: weekResults });
      }),
    );

    return results;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
