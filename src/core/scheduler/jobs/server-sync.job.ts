import type { ScheduledJob } from '../types.js';
import { schedulerRegistry } from '../index.js';
import { logger } from '../../logger/index.js';
import { pterodactylWsManager } from '../../../domains/servers/pterodactyl-ws.manager.js';

class ServerSyncJob implements ScheduledJob {
  readonly id = 'server-sync';
  readonly description = 'Sync Pterodactyl WS connections with MongoDB server list';
  readonly cronExpression = '*/10 * * * *'; // every 10 minutes

  async execute(): Promise<void> {
    await pterodactylWsManager.refresh();
    logger.debug({ jobId: this.id }, 'Server sync completed');
  }
}

await schedulerRegistry.register(new ServerSyncJob());
