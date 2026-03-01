// Tests for OAuth routes (/oauth/client-metadata.json, /authorize, /callback)

import express from 'express';
import request from 'supertest';
import { createOAuthRouter } from '../../routes/oauth';
import type { ServiceConfig } from '../../config';

// Mock the oauth module so we don't need a real NodeOAuthClient
jest.mock('../../oauth', () => ({
  getOAuthClient: jest.fn(),
}));

const { getOAuthClient } = jest.requireMock('../../oauth') as { getOAuthClient: jest.Mock };

const makeConfig = (overrides: Partial<ServiceConfig> = {}): ServiceConfig => ({
  port: 1986,
  serviceUrl: 'http://localhost:1986',
  plcRoot: 'https://plc.directory',
  handleResolverUrl: 'https://api.bsky.app',
  databaseType: 'sqlite',
  databasePath: ':memory:',
  encryptionKey: 'a'.repeat(64),
  maxDraftsPerUser: null,
  allowedCollections: '*',
  oauthScope: 'atproto repo:*?action=create blob:*/*',
  ...overrides,
});

function makeApp(config: ServiceConfig) {
  const app = express();
  app.use('/oauth', createOAuthRouter(config));
  return app;
}

describe('GET /oauth/client-metadata.json', () => {
  it('returns client metadata JSON', async () => {
    const app = makeApp(makeConfig({ serviceUrl: 'https://alf.example.com' }));
    const res = await request(app).get('/oauth/client-metadata.json');
    expect(res.status).toBe(200);
    expect(res.body.client_id).toBe('https://alf.example.com/oauth/client-metadata.json');
    expect(res.body.scope).toContain('atproto');
    expect(res.body.dpop_bound_access_tokens).toBe(true);
  });
});

describe('GET /oauth/authorize', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 400 when handle is missing', async () => {
    const app = makeApp(makeConfig());
    const res = await request(app).get('/oauth/authorize');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/handle/i);
  });

  it('returns 400 when redirect_uri is not a valid URL', async () => {
    const app = makeApp(makeConfig());
    const res = await request(app).get('/oauth/authorize?handle=alice.bsky.social&redirect_uri=not-a-url');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/redirect_uri/i);
  });

  it('returns 400 when redirect_uri uses HTTP on a production (HTTPS) service', async () => {
    const app = makeApp(makeConfig({ serviceUrl: 'https://alf.example.com' }));
    const res = await request(app)
      .get('/oauth/authorize?handle=alice.bsky.social&redirect_uri=http://evil.example.com/callback');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/https/i);
  });

  it('allows HTTP loopback redirect_uri even on a production service', async () => {
    getOAuthClient.mockReturnValue({
      authorize: jest.fn().mockResolvedValue(new URL('https://pds.example.com/authorize?response_type=code')),
    });
    const app = makeApp(makeConfig({ serviceUrl: 'https://alf.example.com' }));
    const res = await request(app)
      .get('/oauth/authorize?handle=alice.bsky.social&redirect_uri=http://127.0.0.1:3100/');
    expect(res.status).toBe(302);
  });

  it('redirects to PDS authorization URL on success', async () => {
    getOAuthClient.mockReturnValue({
      authorize: jest.fn().mockResolvedValue(new URL('https://pds.example.com/authorize?code=abc')),
    });
    const app = makeApp(makeConfig());
    const res = await request(app).get('/oauth/authorize?handle=alice.bsky.social');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('pds.example.com');
  });

  it('stores redirect_uri in pendingRedirects when provided', async () => {
    const mockAuthorize = jest.fn().mockResolvedValue(new URL('https://pds.example.com/auth'));
    getOAuthClient.mockReturnValue({ authorize: mockAuthorize });
    const app = makeApp(makeConfig());
    await request(app).get('/oauth/authorize?handle=alice.bsky.social&redirect_uri=http://localhost:3100/');
    // state was passed as an option to authorize()
    const callOpts = mockAuthorize.mock.calls[0][1] as { state?: string };
    expect(callOpts.state).toBeDefined();
  });

  it('returns 500 when oauthClient.authorize throws', async () => {
    getOAuthClient.mockReturnValue({
      authorize: jest.fn().mockRejectedValue(new Error('PDS unreachable')),
    });
    const app = makeApp(makeConfig());
    const res = await request(app).get('/oauth/authorize?handle=alice.bsky.social');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Authorization failed');
  });

  it('returns 500 with string message when authorize throws a non-Error', async () => {
    getOAuthClient.mockReturnValue({
      authorize: jest.fn().mockRejectedValue('string rejection'),
    });
    const app = makeApp(makeConfig());
    const res = await request(app).get('/oauth/authorize?handle=alice.bsky.social');
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('string rejection');
  });
});

describe('GET /oauth/callback', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 400 when code is missing', async () => {
    const app = makeApp(makeConfig());
    const res = await request(app).get('/oauth/callback');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/code/i);
  });

  it('returns JSON success when no redirect_uri is pending', async () => {
    getOAuthClient.mockReturnValue({
      callback: jest.fn().mockResolvedValue({
        session: { sub: 'did:plc:alice' },
        state: undefined,
      }),
    });
    const app = makeApp(makeConfig());
    const res = await request(app).get('/oauth/callback?code=abc123');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.did).toBe('did:plc:alice');
  });

  it('redirects to app redirect_uri when state matches a pending redirect', async () => {
    // First, plant a pending redirect by calling /authorize
    const stateHolder: { state?: string } = {};
    const mockAuthorize = jest.fn().mockImplementation((_handle: string, opts: { state?: string }) => {
      stateHolder.state = opts?.state;
      return Promise.resolve(new URL('https://pds.example.com/auth'));
    });
    const mockCallback = jest.fn().mockImplementation(() =>
      Promise.resolve({ session: { sub: 'did:plc:alice' }, state: stateHolder.state }),
    );
    getOAuthClient.mockReturnValue({ authorize: mockAuthorize, callback: mockCallback });

    const app = makeApp(makeConfig());
    await request(app).get('/oauth/authorize?handle=alice.bsky.social&redirect_uri=http://localhost:3100/');

    const callbackRes = await request(app).get(`/oauth/callback?code=abc123`);
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.location).toContain('localhost:3100');
    expect(callbackRes.headers.location).toContain('did=did%3Aplc%3Aalice');
  });

  it('returns 500 when oauthClient.callback throws', async () => {
    getOAuthClient.mockReturnValue({
      callback: jest.fn().mockRejectedValue(new Error('exchange failed')),
    });
    const app = makeApp(makeConfig());
    const res = await request(app).get('/oauth/callback?code=bad');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Authorization callback failed');
  });

  it('returns 500 with string message when callback throws a non-Error', async () => {
    getOAuthClient.mockReturnValue({
      callback: jest.fn().mockRejectedValue('string rejection'),
    });
    const app = makeApp(makeConfig());
    const res = await request(app).get('/oauth/callback?code=abc');
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('string rejection');
  });
});
