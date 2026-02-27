// ABOUTME: HTTP server for exposing Prometheus metrics and health check endpoints

import http from 'node:http';
import { Registry } from 'prom-client';
import { createLogger } from './logger.js';

const logger = createLogger('MetricsServer');

export interface MetricsServerOptions {
  registry: Registry;
  port?: number;
  hostname?: string;
}

/**
 * Creates a simple HTTP server that exposes Prometheus metrics.
 *
 * This server is separate from the main application to allow monitoring
 * systems to scrape metrics on a dedicated port (default 9091) without
 * interfering with the ALF service's main operation.
 *
 * The server listens on 0.0.0.0 to allow external scraping systems
 * (Prometheus, Grafana Cloud, Fly.io, etc.) to access the metrics endpoint.
 */
export function createMetricsServer(options: MetricsServerOptions): http.Server {
  const { registry, port = 9091, hostname = '0.0.0.0' } = options;

  const server = http.createServer((req, res) => {
    if (req.url === '/metrics') {
      registry.metrics()
        .then((metrics) => {
          res.setHeader('Content-Type', registry.contentType);
          res.statusCode = 200;
          res.end(metrics);
        })
        .catch((err) => {
          logger.error('Error generating metrics', err as Error);
          res.statusCode = 500;
          res.end('Internal Server Error');
        });
    } else if (req.url === '/health' || req.url === '/_health') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    } else {
      res.statusCode = 404;
      res.end('Not Found');
    }
  });

  server.listen(port, hostname, () => {
    logger.info(`Server listening on http://${hostname}:${port}`);
    logger.info('Endpoints: /metrics, /health');
  });

  return server;
}

/**
 * Gracefully shuts down the metrics server.
 */
export async function destroyMetricsServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        logger.error('Error closing server', err);
        reject(err);
      } else {
        logger.info('Server closed');
        resolve();
      }
    });
  });
}
