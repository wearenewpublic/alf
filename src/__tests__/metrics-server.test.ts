// Tests for the metrics HTTP server

import http from 'node:http';
import { Registry } from 'prom-client';
import { createMetricsServer, destroyMetricsServer } from '../metrics-server';

describe('createMetricsServer default port', () => {
  it('uses port 9091 when no port is specified', () => {
    const registry = new Registry();
    let capturedPort: unknown;
    // Spy on server.listen to capture the port without binding
    const createServerSpy = jest.spyOn(http, 'createServer').mockImplementationOnce((handler) => {
      const mockServer = {
        listen: jest.fn().mockImplementation(function(this: unknown, port: unknown) {
          capturedPort = port;
          return this;
        }),
        on: jest.fn().mockReturnThis(),
        once: jest.fn().mockReturnThis(),
        close: jest.fn(),
      };
      void handler;
      return mockServer as unknown as http.Server;
    });

    createMetricsServer({ registry });
    expect(capturedPort).toBe(9091);
    createServerSpy.mockRestore();
  });
});

function httpGet(port: number, path: string): Promise<{ status: number; body: string; contentType: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body,
        contentType: res.headers['content-type'],
      }));
    });
    req.on('error', reject);
  });
}

describe('createMetricsServer', () => {
  let server: http.Server;
  let port: number;
  let registry: Registry;

  beforeEach(async () => {
    registry = new Registry();
    // Use port 0 to let the OS pick a free port
    server = createMetricsServer({ registry, port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await destroyMetricsServer(server);
  });

  it('returns metrics on GET /metrics', async () => {
    registry.setDefaultLabels({ service: 'test' });
    const { status, contentType } = await httpGet(port, '/metrics');
    expect(status).toBe(200);
    expect(contentType).toMatch(/text\/plain/);
  });

  it('returns 200 JSON on GET /health', async () => {
    const { status, body, contentType } = await httpGet(port, '/health');
    expect(status).toBe(200);
    expect(contentType).toMatch(/application\/json/);
    const data = JSON.parse(body) as { status: string };
    expect(data.status).toBe('ok');
  });

  it('returns 200 JSON on GET /_health', async () => {
    const { status, body } = await httpGet(port, '/_health');
    expect(status).toBe(200);
    const data = JSON.parse(body) as { status: string };
    expect(data.status).toBe('ok');
  });

  it('returns 404 for unknown paths', async () => {
    const { status } = await httpGet(port, '/unknown');
    expect(status).toBe(404);
  });

  it('handles metrics generation error gracefully', async () => {
    jest.spyOn(registry, 'metrics').mockRejectedValueOnce(new Error('metrics boom'));
    const { status } = await httpGet(port, '/metrics');
    expect(status).toBe(500);
  });
});

describe('destroyMetricsServer', () => {
  it('resolves when the server closes cleanly', async () => {
    const registry = new Registry();
    const server = createMetricsServer({ registry, port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    await expect(destroyMetricsServer(server)).resolves.toBeUndefined();
  });

  it('rejects when the server was never listening', async () => {
    // Create a server but never start it — close() immediately errors
    const server = http.createServer();
    await expect(destroyMetricsServer(server)).rejects.toThrow();
  });
});
