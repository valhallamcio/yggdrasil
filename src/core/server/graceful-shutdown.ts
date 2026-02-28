import type { Server as HttpServer } from 'node:http';
import { logger } from '../logger/index.js';
import { disconnectDatabase } from '../database/client.js';
import { schedulerRegistry } from '../scheduler/index.js';
import { pluginRegistry } from '../../plugins/index.js';

export function registerGracefulShutdown(server: HttpServer): void {
  let isShuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info({ signal }, 'Shutdown signal received, beginning graceful shutdown');

    // Force exit after timeout if graceful shutdown hangs
    const forceExitTimer = setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 15_000);
    forceExitTimer.unref();

    try {
      // 1. Stop accepting new connections
      await new Promise<void>((resolve) => server.close(() => resolve()));
      logger.info('HTTP server closed');

      // 2. Stop all scheduled jobs
      schedulerRegistry.stopAll();

      // 3. Stop stats recorders and live connections
      const { statsRecorder } = await import('../../domains/servers/stats-recorder.js');
      statsRecorder.stop();
      const { pterodactylWsManager } = await import('../../domains/servers/pterodactyl-ws.manager.js');
      pterodactylWsManager.disconnect();
      const { metricsCollector } = await import('../../domains/players/metrics-collector.js');
      metricsCollector.stop();
      const { playerStatsRecorder } = await import('../../domains/players/player-stats-recorder.js');
      playerStatsRecorder.stop();
      const { sessionRecorder } = await import('../../domains/players/session-recorder.js');
      sessionRecorder.stop();
      const { peakTracker } = await import('../../domains/players/peak-tracker.js');
      peakTracker.stop();

      // 4. Shutdown plugins in reverse order
      await pluginRegistry.shutdownAll();

      // 5. Disconnect from MongoDB
      await disconnectDatabase();

      clearTimeout(forceExitTimer);
      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection');
  });
}
