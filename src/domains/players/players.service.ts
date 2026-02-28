import type { WithId } from 'mongodb';
import type { PlayersRepository } from './players.repository.js';
import { PterodactylClient } from '../servers/pterodactyl.client.js';
import { ServersRepository } from '../servers/servers.repository.js';
import { metricsCollector } from './metrics-collector.js';
import { binaryToUuid } from '../../shared/utils/uuid.js';
import { AppError, NotFoundError } from '../../shared/errors/index.js';
import { logger } from '../../core/logger/index.js';
import { playerStatsRecorder } from './player-stats-recorder.js';
import { peakTracker } from './peak-tracker.js';
import type {
  PlayerDocument,
  PlayerDto,
  OnlinePlayerDto,
  PlayerPositionDto,
  PlayerMetrics,
  LeaderboardEntryDto,
  PlayerHistoryDocument,
  PlayerAnalyticsDto,
} from './players.types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let nbtLib: any;

async function getNbt() {
  if (!nbtLib) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mod = await import('mc-nbt-lib');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    nbtLib = new mod.MinecraftNBT();
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return nbtLib;
}

function earliestDate(rec: Record<string, Date>): Date {
  return new Date(Math.min(...Object.values(rec).map((d) => new Date(d).getTime())));
}

function latestDate(rec: Record<string, Date>): Date {
  return new Date(Math.max(...Object.values(rec).map((d) => new Date(d).getTime())));
}

function toPlayerDto(doc: WithId<PlayerDocument>, online: boolean, currentServer: string | null, latency: PlayerMetrics | null): PlayerDto {
  return {
    username: doc.username,
    uuid: binaryToUuid(doc.uuid),
    nickname: doc.nickname ?? null,
    discordId: doc.discord_id ?? null,
    firstSeen: earliestDate(doc.first_seen).toISOString(),
    lastSeen: doc.leave_dates ? latestDate(doc.leave_dates).toISOString() : null,
    lastServer: doc.server,
    playtime: doc.playtime,
    online,
    currentServer,
    latency,
  };
}

export class PlayersService {
  private readonly pterodactyl = new PterodactylClient();
  private readonly serversRepo = new ServersRepository();

  constructor(private readonly repo: PlayersRepository) {}

  // ── Online Players ──────────────────────────────────────────────────

  getOnlinePlayers(): Record<string, OnlinePlayerDto[]> {
    return metricsCollector.getOnlinePlayers();
  }

  // ── Individual Player ─────────────────────────────────────────────

  async getPlayer(nick: string): Promise<PlayerDto> {
    const doc = await this.requirePlayer(nick);
    const info = metricsCollector.getPlayerInfo(doc.username);
    const online = !!info;

    return toPlayerDto(
      doc,
      online,
      info?.server ?? null,
      info ? { latencyP95: info.latency.latencyP95, latencyAvg: info.latency.latencyAvg, latencyMin: info.latency.latencyMin, latencyMax: info.latency.latencyMax } : null,
    );
  }

  // ── Search ────────────────────────────────────────────────────────

  async searchPlayers(query: string, limit: number): Promise<PlayerDto[]> {
    const docs = await this.repo.searchByUsername(query, limit);
    return docs.map((doc) => {
      const info = metricsCollector.getPlayerInfo(doc.username);
      return toPlayerDto(doc, !!info, info?.server ?? null, info ? info.latency : null);
    });
  }

  // ── Leaderboard ───────────────────────────────────────────────────

  async getLeaderboard(sort: 'playtime' | 'first_seen', limit: number, tag?: string): Promise<LeaderboardEntryDto[]> {
    if (sort === 'first_seen') {
      const docs = await this.repo.findTopByFirstSeen(limit);
      return docs.map((doc) => ({
        username: doc.username,
        uuid: binaryToUuid(doc.uuid),
        value: earliestDate(doc.first_seen).getTime(),
      }));
    }

    const docs = await this.repo.findTopByPlaytime(limit, tag);
    return docs.map((doc) => {
      const totalPlaytime = tag
        ? (doc.playtime[tag] ?? 0)
        : Object.values(doc.playtime).reduce((sum, v) => sum + v, 0);
      return {
        username: doc.username,
        uuid: binaryToUuid(doc.uuid),
        value: totalPlaytime,
      };
    });
  }

  // ── History ───────────────────────────────────────────────────────

  async getPlayerHistory(from: Date, to: Date, server?: string): Promise<PlayerHistoryDocument[]> {
    const docs = await this.repo.findPlayerHistory(from, to, server);

    // Append live snapshot if querying up to "now"
    if (to.getTime() >= Date.now() - 120_000) {
      const snapshot = playerStatsRecorder.getCurrentSnapshot();
      const source = server ?? 'global';
      const info = server ? snapshot.servers[server] : snapshot.global;
      if (info && info.count > 0) {
        docs.push({
          timestamp: new Date(),
          source,
          playerCount: info.count,
          peakPlayerCount: info.peakCount,
          avgLatencyP95: 0,
          avgLatencyAvg: 0,
        });
      }
    }

    return docs;
  }

  // ── Analytics ──────────────────────────────────────────────────────

  private analyticsCache = new Map<string, { data: PlayerAnalyticsDto; expiry: number }>();

  async getAnalytics(server?: string): Promise<PlayerAnalyticsDto> {
    const cacheKey = server ?? '__global__';
    const cached = this.analyticsCache.get(cacheKey);
    if (cached && cached.expiry > Date.now()) return cached.data;

    const [populationStats, newPlayerCounts, uniqueActive, sessionStats, classification, allTimePeak, weeklyGrowth, retentionCohorts] =
      await Promise.all([
        this.repo.getPopulationStats(server),
        this.repo.getNewPlayerCounts(server),
        this.repo.getUniqueActivePlayers(server),
        this.repo.getSessionStats(server),
        this.repo.getPlayerClassification(server),
        this.repo.findAllTimePeak(server),
        this.repo.getWeeklyGrowth(8, server),
        this.repo.getRetentionCohorts(8, server),
      ]);

    // Live data from metrics collector
    const onlinePlayers = metricsCollector.getOnlinePlayers();
    const serverCounts: Record<string, number> = {};
    let totalOnline = 0;
    for (const [tag, players] of Object.entries(onlinePlayers)) {
      serverCounts[tag] = players.length;
      totalOnline += players.length;
    }

    const data: PlayerAnalyticsDto = {
      current: {
        online: server ? (serverCounts[server] ?? 0) : totalOnline,
        servers: serverCounts,
      },
      peaks: {
        allTime: allTimePeak,
        lastPeak: peakTracker.getLastPeak(server),
      },
      population: populationStats,
      newPlayers: newPlayerCounts,
      uniqueActive,
      sessions: sessionStats,
      classification,
      growth: weeklyGrowth,
      retention: retentionCohorts,
    };

    this.analyticsCache.set(cacheKey, { data, expiry: Date.now() + 60_000 });
    return data;
  }

  // ── Player Stats (JSON file) ──────────────────────────────────────

  async getPlayerStats(nick: string, tag: string): Promise<unknown> {
    const { uuid, serverId } = await this.resolvePlayerAndServer(nick, tag);
    try {
      const content = await this.pterodactyl.readFile(serverId, `/world/stats/${uuid}.json`);
      return JSON.parse(content) as unknown;
    } catch (err) {
      if (err instanceof AppError) throw err;
      this.throwPlayerDataNotFound(nick, tag);
    }
  }

  async updatePlayerStats(nick: string, tag: string, stats: Record<string, Record<string, number>>): Promise<void> {
    const { uuid, serverId } = await this.resolvePlayerAndServer(nick, tag);
    let content: string;
    try {
      content = await this.pterodactyl.readFile(serverId, `/world/stats/${uuid}.json`);
    } catch (err) {
      if (err instanceof AppError) throw err;
      this.throwPlayerDataNotFound(nick, tag);
    }
    const existing = JSON.parse(content) as { stats: Record<string, Record<string, number>>; DataVersion: number };
    existing.stats = { ...existing.stats, ...stats };
    await this.pterodactyl.writeFile(serverId, `/world/stats/${uuid}.json`, JSON.stringify(existing, null, 2));
  }

  // ── Player Inventory (NBT .dat file) ──────────────────────────────

  async getPlayerInventory(nick: string, tag: string): Promise<unknown> {
    const nbtData = await this.readPlayerData(nick, tag);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mc = await getNbt();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const inventory = mc.getValue(nbtData, 'Inventory');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const enderItems = mc.getValue(nbtData, 'EnderItems');
    return { inventory: inventory?.value ?? null, enderItems: enderItems?.value ?? null };
  }

  async updatePlayerInventory(nick: string, tag: string, inventory: unknown[]): Promise<void> {
    const { uuid, serverId } = await this.resolvePlayerAndServer(nick, tag);
    const filePath = `/world/playerdata/${uuid}.dat`;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
    let nbtData: any;
    try {
      const buffer = await this.pterodactyl.readBinaryFile(serverId, filePath);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const mc = await getNbt();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      nbtData = mc.parseCompressedNBT(buffer);
    } catch (err) {
      if (err instanceof AppError) throw err;
      this.throwPlayerDataNotFound(nick, tag);
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mc = await getNbt();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    mc.setValue(nbtData, 'Inventory', {
      type: 'list',
      value: { type: 'compound', value: inventory },
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const compressed: Buffer = mc.stringifyCompressedNBT(nbtData);
    await this.pterodactyl.writeBinaryFile(serverId, filePath, compressed);
  }

  // ── Player Position (NBT .dat file) ───────────────────────────────

  async getPlayerPosition(nick: string, tag: string): Promise<PlayerPositionDto> {
    const nbtData = await this.readPlayerData(nick, tag);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mc = await getNbt();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const pos = mc.getValue(nbtData, 'Pos');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const rotation = mc.getValue(nbtData, 'Rotation');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const dimension = mc.getValue(nbtData, 'Dimension');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const gameMode = mc.getValue(nbtData, 'playerGameType');

    const posValues = pos?.value?.value ?? [0, 0, 0];
    const rotValues = rotation?.value?.value ?? [0, 0];

    return {
      x: Number(posValues[0]),
      y: Number(posValues[1]),
      z: Number(posValues[2]),
      yaw: Number(rotValues[0]),
      pitch: Number(rotValues[1]),
      dimension: dimension?.value ?? 'minecraft:overworld',
      gameMode: Number(gameMode?.value ?? 0),
    };
  }

  async updatePlayerPosition(
    nick: string,
    tag: string,
    position: { x: number; y: number; z: number; yaw?: number; pitch?: number; dimension?: string; gameMode?: number },
  ): Promise<void> {
    const { uuid, serverId } = await this.resolvePlayerAndServer(nick, tag);
    const filePath = `/world/playerdata/${uuid}.dat`;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
    let nbtData: any;
    try {
      const buffer = await this.pterodactyl.readBinaryFile(serverId, filePath);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const mc = await getNbt();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      nbtData = mc.parseCompressedNBT(buffer);
    } catch (err) {
      if (err instanceof AppError) throw err;
      this.throwPlayerDataNotFound(nick, tag);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mc = await getNbt();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    mc.setValue(nbtData, 'Pos', {
      type: 'list',
      value: { type: 'double', value: [position.x, position.y, position.z] },
    });

    if (position.yaw !== undefined || position.pitch !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const currentRot = mc.getValue(nbtData, 'Rotation');
      const currentValues = currentRot?.value?.value ?? [0, 0];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      mc.setValue(nbtData, 'Rotation', {
        type: 'list',
        value: { type: 'float', value: [position.yaw ?? Number(currentValues[0]), position.pitch ?? Number(currentValues[1])] },
      });
    }

    if (position.dimension !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      mc.setValue(nbtData, 'Dimension', { type: 'string', value: position.dimension });
    }

    if (position.gameMode !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      mc.setValue(nbtData, 'playerGameType', { type: 'int', value: position.gameMode });
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const compressed: Buffer = mc.stringifyCompressedNBT(nbtData);
    await this.pterodactyl.writeBinaryFile(serverId, filePath, compressed);
  }

  // ── Advancements (JSON file) ──────────────────────────────────────

  async getPlayerAdvancements(nick: string, tag: string): Promise<unknown> {
    const { uuid, serverId } = await this.resolvePlayerAndServer(nick, tag);
    try {
      const content = await this.pterodactyl.readFile(serverId, `/world/advancements/${uuid}.json`);
      return JSON.parse(content) as unknown;
    } catch (err) {
      if (err instanceof AppError) throw err;
      this.throwPlayerDataNotFound(nick, tag);
    }
  }

  // ── Skin ──────────────────────────────────────────────────────────

  getSkinUrl(nick: string, size: number): string {
    return `https://mc-heads.net/avatar/${encodeURIComponent(nick)}/${size}`;
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private throwPlayerDataNotFound(nick: string, tag: string): never {
    throw new NotFoundError('Player data', `${nick}" on server "${tag}`);
  }

  private async requirePlayer(nick: string): Promise<WithId<PlayerDocument>> {
    const doc = await this.repo.findByUsername(nick);
    if (!doc) throw new NotFoundError('Player', nick);
    return doc;
  }

  private async resolvePlayerAndServer(nick: string, tag: string): Promise<{ uuid: string; serverId: string }> {
    const player = await this.requirePlayer(nick);
    const uuid = binaryToUuid(player.uuid);

    const server = await this.serversRepo.findByTag(tag);
    if (!server) throw new NotFoundError('Server', tag);

    return { uuid, serverId: server.serverId };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async readPlayerData(nick: string, tag: string): Promise<any> {
    const { uuid, serverId } = await this.resolvePlayerAndServer(nick, tag);
    try {
      const buffer = await this.pterodactyl.readBinaryFile(serverId, `/world/playerdata/${uuid}.dat`);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const mc = await getNbt();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      return mc.parseCompressedNBT(buffer);
    } catch (err) {
      if (err instanceof AppError) throw err;
      this.throwPlayerDataNotFound(nick, tag);
    }
  }
}
