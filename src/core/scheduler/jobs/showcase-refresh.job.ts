import type { ScheduledJob } from '../types.js';
import { schedulerRegistry } from '../index.js';
import { logger } from '../../logger/index.js';
import { config } from '../../../config/index.js';
import { ShowcaseRepository } from '../../../domains/showcase/showcase.repository.js';
import { ShowcaseService } from '../../../domains/showcase/showcase.service.js';

class ShowcaseRefreshJob implements ScheduledJob {
  readonly id = 'showcase-refresh';
  readonly description = 'Refresh showcase screenshot cache from Discord';
  readonly cronExpression = '*/60 * * * *';

  async onInit(): Promise<void> {
    if (!config.DISCORD_SCREENSHOT_CHANNEL_ID) {
      logger.warn('DISCORD_SCREENSHOT_CHANNEL_ID not set, showcase refresh job will no-op');
      return;
    }

    logger.info('Showcase refresh job: running initial cache population');
    try {
      await this.refresh();
    } catch (err) {
      logger.error({ err }, 'Showcase initial cache population failed (non-fatal)');
    }
  }

  async execute(): Promise<void> {
    if (!config.DISCORD_SCREENSHOT_CHANNEL_ID) return;
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    const repo = new ShowcaseRepository();
    const service = new ShowcaseService(repo);
    const result = await service.refreshCache();
    logger.info({ jobId: this.id, postCount: result.postCount }, 'Showcase cache refreshed by scheduler');
  }
}

await schedulerRegistry.register(new ShowcaseRefreshJob());
