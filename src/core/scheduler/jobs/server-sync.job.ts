import type { ScheduledJob } from '../types.js';
import { schedulerRegistry } from '../index.js';
import { logger } from '../../logger/index.js';
import { pterodactylWsManager } from '../../../domains/servers/pterodactyl-ws.manager.js';
import { ServerRegistryRepository } from '../../../domains/servers/server-registry.repository.js';
import { ServersRepository } from '../../../domains/servers/servers.repository.js';

const registryRepo = new ServerRegistryRepository();
const sourceRepo = new ServersRepository();

async function syncRegistry(): Promise<void> {
  const sourceServers = await sourceRepo.findAll();
  const activeTags = new Set<string>();

  for (const s of sourceServers) {
    activeTags.add(s.tag);
    await registryRepo.upsertFromSource({
      tag: s.tag,
      name: s.name,
      desc: s.desc,
      color: s.color,
      image: s.image,
      genre: s.genre,
      platform: s.platform,
      serverVersion: s.server_version,
      modpackVersion: s.modpack_version,
      earlyAccess: s.early_access,
    });
  }

  const deactivated = await registryRepo.deactivateMissing(activeTags);
  if (deactivated > 0) {
    logger.info({ deactivated }, 'Deactivated servers missing from source');
  }
}

class ServerSyncJob implements ScheduledJob {
  readonly id = 'server-sync';
  readonly description = 'Sync server registry and Pterodactyl WS connections with MongoDB server list';
  readonly cronExpression = '*/10 * * * *'; // every 10 minutes

  async onInit(): Promise<void> {
    await registryRepo.ensureIndexes();
    await syncRegistry();
    logger.info({ jobId: this.id }, 'Server registry initially populated');
  }

  async execute(): Promise<void> {
    await syncRegistry();
    await pterodactylWsManager.refresh();
    logger.debug({ jobId: this.id }, 'Server sync completed');
  }
}

await schedulerRegistry.register(new ServerSyncJob());
