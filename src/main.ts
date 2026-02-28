// Entry point — initialization order matters:
// config → logger → db → app → http server → graceful shutdown → plugins → schedulers → listen

import { config } from './config/index.js';
import { logger } from './core/logger/index.js';
import { connectDatabase } from './core/database/client.js';
import { createApp } from './app.js';
import { createServer } from 'node:http';
import { loadPlugins, pluginRegistry } from './plugins/index.js';
import { schedulerRegistry } from './core/scheduler/index.js';
import { registerGracefulShutdown } from './core/server/graceful-shutdown.js';

// Side-effect imports for scheduler jobs — uncomment or add as you create jobs:
// import './core/scheduler/jobs/cleanup.job.js';

async function bootstrap(): Promise<void> {
  logger.info('Yggdrasil bootstrap starting');

  // 1. Connect to MongoDB (fast-fail if unreachable)
  await connectDatabase();

  // 1b. Register scheduler jobs (dynamic import — must run after DB is connected)
  await import('./core/scheduler/jobs/showcase-refresh.job.js');
  await import('./core/scheduler/jobs/server-sync.job.js');

  // 1c. Initialize Pterodactyl WebSocket connections for live server stats
  const { pterodactylWsManager } = await import('./domains/servers/pterodactyl-ws.manager.js');
  await pterodactylWsManager.connect();

  // 1d. Start recording server stats to time series collection
  const { statsRecorder } = await import('./domains/servers/stats-recorder.js');
  await statsRecorder.start();

  // 1e. Initialize player metrics collector (Velocity proxy Prometheus)
  const { metricsCollector } = await import('./domains/players/metrics-collector.js');
  await metricsCollector.start();

  // 1f. Start recording player stats to time series collection
  const { playerStatsRecorder } = await import('./domains/players/player-stats-recorder.js');
  await playerStatsRecorder.start();

  // 1g. Start recording player sessions
  const { sessionRecorder } = await import('./domains/players/session-recorder.js');
  await sessionRecorder.start();

  // 1h. Start peak tracker
  const { peakTracker } = await import('./domains/players/peak-tracker.js');
  peakTracker.start();

  // 2. Build the Express app (pure, no I/O)
  const app = createApp();

  // 3. Wrap in a raw http.Server (required for WebSocket protocol upgrade)
  const server = createServer(app);

  // 4. Register graceful shutdown handlers before any async work
  registerGracefulShutdown(server);

  // 5. Load and initialize enabled plugins (dynamic imports, conditional on env flags)
  await loadPlugins();
  await pluginRegistry.initAll(app, server);

  // 6. Start all registered scheduler jobs
  schedulerRegistry.startAll();

  // 7. Begin accepting connections
  await new Promise<void>((resolve) => {
    server.listen(config.PORT, config.HOST, resolve);
  });

  logger.info(
    { host: config.HOST, port: config.PORT, env: config.NODE_ENV },
    'Yggdrasil server listening'
  );
}

bootstrap().catch((err) => {
  // Logger may not be initialized yet — use console as fallback
  console.error('Fatal error during bootstrap:', err);
  process.exit(1);
});
