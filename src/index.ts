// ABOUTME: Entry point for the ALF (Atproto Latency Fabric) service

import { createServer } from './server.js';
import { getConfig } from './config.js';
import { createDb, initializeSchema } from './database.js';
import { setDb } from './storage.js';
import { createOAuthClient, setOAuthClient } from './oauth.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { createLogger } from './logger.js';
import { createMetricsServer, destroyMetricsServer } from './metrics-server.js';
import { registry, serverState, startupTimestamp } from './metrics.js';

const logger = createLogger('Main');

async function main() {
  logger.info('===========================================');
  logger.info('    Scheduled Posts Service Starting Up');
  logger.info('===========================================');

  try {
    const config = getConfig();

    logger.info('Configuration loaded');
    logger.info(`Service URL: ${config.serviceUrl}`);
    logger.info(`PLC Root: ${config.plcRoot}`);
    logger.info(`Database Type: ${config.databaseType}`);
    logger.info(`Port: ${config.port}`);

    // Initialize database
    const db = createDb(config);
    await initializeSchema(db, config);
    setDb(db);
    logger.info('Database initialized');

    // Initialize OAuth client
    const oauthClient = createOAuthClient(config);
    setOAuthClient(oauthClient);
    logger.info('OAuth client initialized');

    const app = createServer(config);

    const isProduction = process.env.NODE_ENV === 'production';

    const server = isProduction
      ? app.listen(config.port, '::', () => {
          logger.info(`Scheduled Posts listening on :::${config.port}`);
          logger.info(`Health check: http://localhost:${config.port}/health`);
          logger.info(`OAuth authorize: http://localhost:${config.port}/oauth/authorize`);
          logger.info(`XRPC endpoint: http://localhost:${config.port}/xrpc`);
        })
      : app.listen(config.port, () => {
          logger.info(`Scheduled Posts listening on 0.0.0.0:${config.port}`);
          logger.info(`Health check: http://localhost:${config.port}/health`);
          logger.info(`OAuth authorize: http://localhost:${config.port}/oauth/authorize`);
          logger.info(`XRPC endpoint: http://localhost:${config.port}/xrpc`);
        });

    // Start background scheduler
    startScheduler(config);

    // Start metrics server (production only)
    let metricsServer: ReturnType<typeof createMetricsServer> | null = null;
    if (isProduction) {
      metricsServer = createMetricsServer({ registry, port: 9091 });
    }

    serverState.set(1);
    startupTimestamp.set(Date.now() / 1000);

    const shutdown = async () => {
      logger.info('Received shutdown signal');
      serverState.set(0);
      stopScheduler();

      if (metricsServer) {
        await destroyMetricsServer(metricsServer).catch(() => {});
      }

      server.close(() => {
        logger.info('Server closed');
        process.exit(0);
      });

      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => { void shutdown(); });
    process.on('SIGINT', () => { void shutdown(); });
  } catch (error) {
    logger.error('Fatal error', error as Error);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  logger.error('Unhandled error', error as Error);
  process.exit(1);
});
