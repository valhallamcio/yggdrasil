import type { WithId } from 'mongodb';
import type { ServersRepository } from './servers.repository.js';
import { PterodactylClient } from './pterodactyl.client.js';
import { pterodactylWsManager } from './pterodactyl-ws.manager.js';
import { NotFoundError } from '../../shared/errors/index.js';
import type {
  ServerDocument,
  ServerDto,
  ServerPublicDto,
  ServerWithStatsDto,
  FileEntryDto,
  StatsHistoryDocument,
} from './servers.types.js';

function toServerDto(doc: WithId<ServerDocument>): ServerDto {
  return {
    id: doc._id.toHexString(),
    tag: doc.tag,
    name: doc.name,
    desc: doc.desc,
    hostname: doc.hostname,
    port: doc.port,
    color: doc.color,
    serverVersion: doc.server_version,
    modpackVersion: doc.modpack_version,
    platform: doc.platform,
    earlyAccess: doc.early_access,
    excludeFromServerList: doc.excludeFromServerList ?? false,
    discordRoleId: doc.discord_role_id,
    serverId: doc.serverId,
    fileID: doc.fileID,
    newestFileID: doc.newestFileID,
    requiresUpdate: doc.requiresUpdate,
    modpackID: doc.modpackID,
  };
}

function toServerPublicDto(
  doc: WithId<ServerDocument>,
  status: string,
  players: number,
  tps: number,
): ServerPublicDto {
  return {
    tag: doc.tag,
    name: doc.name,
    desc: doc.desc,
    color: doc.color,
    image: doc.image,
    genre: doc.genre,
    platform: doc.platform,
    serverVersion: doc.server_version,
    modpackVersion: doc.modpack_version,
    status,
    players,
    tps,
  };
}

export class ServersService {
  private readonly pterodactyl = new PterodactylClient();

  constructor(private readonly repo: ServersRepository) {}

  async getServers(authenticated: boolean): Promise<ServerWithStatsDto[] | ServerPublicDto[]> {
    const [docs, shards] = await Promise.all([
      this.repo.findAll(),
      this.repo.findAllShards(),
    ]);

    if (!authenticated) {
      return docs
        .filter((d) => !d.early_access)
        .map((doc) => {
          const stats = pterodactylWsManager.getStats(doc.tag);
          const shard = shards.find((s) => s.server.equals(doc._id));
          const status = stats?.state ?? pterodactylWsManager.getStatus(doc.tag) ?? 'unknown';
          return toServerPublicDto(doc, status, shard?.players ?? 0, shard?.tps ?? 0);
        });
    }

    return docs.map((doc) => {
      const stats = pterodactylWsManager.getStats(doc.tag);
      const shard = shards.find((s) => s.server.equals(doc._id));

      return {
        ...toServerDto(doc),
        status: stats?.state ?? pterodactylWsManager.getStatus(doc.tag) ?? 'unknown',
        cpu: stats?.cpu_absolute ?? 0,
        memoryBytes: stats?.memory_bytes ?? 0,
        memoryLimitBytes: stats?.memory_limit_bytes ?? 0,
        diskBytes: stats?.disk_bytes ?? 0,
        networkRxBytes: stats?.network.rx_bytes ?? 0,
        networkTxBytes: stats?.network.tx_bytes ?? 0,
        uptimeMs: stats?.uptime ?? 0,
        tps: shard?.tps ?? 0,
        players: shard?.players ?? 0,
        whitelisted: shard?.whitelisted ?? false,
      };
    });
  }

  async getServer(tag: string, authenticated: boolean): Promise<ServerWithStatsDto | ServerPublicDto> {
    const doc = await this.requireServer(tag);

    if (!authenticated && doc.early_access) {
      throw new NotFoundError('Server', tag);
    }

    const stats = pterodactylWsManager.getStats(tag);
    const shard = await this.repo.findShardByServerRef(doc._id);
    const status = stats?.state ?? pterodactylWsManager.getStatus(tag) ?? 'unknown';
    const players = shard?.players ?? 0;
    const tps = shard?.tps ?? 0;

    if (!authenticated) {
      return toServerPublicDto(doc, status, players, tps);
    }

    return {
      ...toServerDto(doc),
      status,
      cpu: stats?.cpu_absolute ?? 0,
      memoryBytes: stats?.memory_bytes ?? 0,
      memoryLimitBytes: stats?.memory_limit_bytes ?? 0,
      diskBytes: stats?.disk_bytes ?? 0,
      networkRxBytes: stats?.network.rx_bytes ?? 0,
      networkTxBytes: stats?.network.tx_bytes ?? 0,
      uptimeMs: stats?.uptime ?? 0,
      tps,
      players,
      whitelisted: shard?.whitelisted ?? false,
    };
  }

  async getServerResources(tag: string): Promise<ServerWithStatsDto> {
    return this.getServer(tag, true) as Promise<ServerWithStatsDto>;
  }

  async updateServer(tag: string, fields: Record<string, unknown>): Promise<void> {
    await this.requireServer(tag);
    const updated = await this.repo.updateByTag(tag, fields);
    if (!updated) throw new NotFoundError('Server', tag);
  }

  async sendCommand(tag: string, command: string): Promise<void> {
    const doc = await this.requireServer(tag);
    await this.pterodactyl.sendCommand(doc.serverId, command);
  }

  async sendPowerAction(tag: string, signal: 'start' | 'stop' | 'restart' | 'kill'): Promise<void> {
    const doc = await this.requireServer(tag);
    await this.pterodactyl.sendPowerAction(doc.serverId, signal);
  }

  async listFiles(tag: string, directory: string): Promise<FileEntryDto[]> {
    const doc = await this.requireServer(tag);
    const entries = await this.pterodactyl.listFiles(doc.serverId, directory);
    return entries.map((e) => ({
      name: e.attributes.name,
      size: e.attributes.size,
      isFile: e.attributes.is_file,
      isSymlink: e.attributes.is_symlink,
      mimetype: e.attributes.mimetype,
      createdAt: e.attributes.created_at,
      modifiedAt: e.attributes.modified_at,
    }));
  }

  async readFile(tag: string, filePath: string): Promise<string> {
    const doc = await this.requireServer(tag);
    return this.pterodactyl.readFile(doc.serverId, filePath);
  }

  async writeFile(tag: string, filePath: string, content: string): Promise<void> {
    const doc = await this.requireServer(tag);
    await this.pterodactyl.writeFile(doc.serverId, filePath, content);
  }

  async getConsoleLogs(tag: string, lines: number): Promise<string> {
    const content = await this.readFile(tag, '/logs/latest.log');
    return content.split('\n').slice(-lines).join('\n');
  }

  async getHistory(tag: string, from: Date, to: Date): Promise<StatsHistoryDocument[]> {
    await this.requireServer(tag);
    return this.repo.findStatsHistory(tag, from, to);
  }

  private async requireServer(tag: string): Promise<WithId<ServerDocument>> {
    const doc = await this.repo.findByTag(tag);
    if (!doc) throw new NotFoundError('Server', tag);
    return doc;
  }
}
