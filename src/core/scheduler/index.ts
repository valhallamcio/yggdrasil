import cron, { type ScheduledTask } from 'node-cron';
import type { ScheduledJob } from './types.js';
import { eventBus } from '../event-bus/index.js';
import { logger } from '../logger/index.js';

export class SchedulerRegistry {
  private readonly tasks = new Map<string, ScheduledTask>();
  private readonly jobs = new Map<string, ScheduledJob>();

  async register(job: ScheduledJob): Promise<void> {
    if (this.jobs.has(job.id)) {
      throw new Error(`Scheduler job "${job.id}" is already registered`);
    }

    if (!cron.validate(job.cronExpression)) {
      throw new Error(`Invalid cron expression for job "${job.id}": ${job.cronExpression}`);
    }

    if (job.onInit) await job.onInit();

    const task = cron.schedule(
      job.cronExpression,
      async () => {
        const start = Date.now();
        const jobLogger = logger.child({ jobId: job.id });
        try {
          jobLogger.debug('Job starting');
          await job.execute();
          const durationMs = Date.now() - start;
          jobLogger.info({ durationMs }, 'Job completed');
          eventBus.emit('scheduler.job.completed', { jobId: job.id, durationMs });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          jobLogger.error({ err }, 'Job failed');
          eventBus.emit('scheduler.job.failed', { jobId: job.id, error });
        }
      },
      { scheduled: false }
    );

    this.tasks.set(job.id, task);
    this.jobs.set(job.id, job);
    logger.info({ jobId: job.id, cron: job.cronExpression }, 'Scheduler job registered');
  }

  startAll(): void {
    for (const [id, task] of this.tasks) {
      task.start();
      logger.info({ jobId: id }, 'Scheduler job started');
    }
  }

  stopAll(): void {
    for (const [id, task] of this.tasks) {
      task.stop();
      logger.info({ jobId: id }, 'Scheduler job stopped');
    }
  }

  list(): string[] {
    return Array.from(this.jobs.keys());
  }
}

// Singleton
export const schedulerRegistry = new SchedulerRegistry();
export type { ScheduledJob } from './types.js';
