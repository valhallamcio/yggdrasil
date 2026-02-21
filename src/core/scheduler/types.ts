export interface ScheduledJob {
  /** Machine-readable identifier, used in logs and events */
  id: string;
  /** Human-readable description */
  description: string;
  /** node-cron schedule expression (e.g. "0 * * * *" for every hour) */
  cronExpression: string;
  /** Called on each tick; errors are caught and emitted as scheduler.job.failed */
  execute(): Promise<void>;
  /** Optional: called once after registration, before first tick */
  onInit?(): Promise<void>;
}
