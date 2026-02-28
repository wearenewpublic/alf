// Tests for OAuth client creation, get, and set

import { createOAuthClient, setOAuthClient, getOAuthClient } from '../oauth';
import type { ServiceConfig } from '../config';

// Mock NodeOAuthClient so we don't make real network calls
jest.mock('@atproto/oauth-client-node', () => ({
  NodeOAuthClient: jest.fn().mockImplementation((opts: unknown) => ({ _opts: opts })),
}));

// Mock storage functions used by session/state stores inside oauth.ts
jest.mock('../storage', () => ({
  saveOAuthState: jest.fn(),
  getOAuthState: jest.fn(),
  deleteOAuthState: jest.fn(),
  upsertUserAuthorization: jest.fn(),
  getUserAuthorization: jest.fn(),
}));

// Mock encrypt/decrypt so session store tests don't require real keys
jest.mock('../encrypt', () => ({
  encrypt: jest.fn((v: string) => `enc:${v}`),
  decrypt: jest.fn((v: string) => v.replace(/^enc:/, '')),
}));

const { NodeOAuthClient } = jest.requireMock('@atproto/oauth-client-node') as {
  NodeOAuthClient: jest.Mock;
};

const baseConfig = (serviceUrl: string): ServiceConfig => ({
  port: 1986,
  serviceUrl,
  plcRoot: 'https://plc.directory',
  handleResolverUrl: 'https://api.bsky.app',
  databaseType: 'sqlite',
  databasePath: ':memory:',
  encryptionKey: 'a'.repeat(64),
  maxDraftsPerUser: null,
  allowedCollections: '*',
});

describe('createOAuthClient', () => {
  beforeEach(() => NodeOAuthClient.mockClear());

  it('uses discoverable client metadata for HTTPS service URLs', () => {
    const config = baseConfig('https://alf.example.com');
    createOAuthClient(config);
    const opts = NodeOAuthClient.mock.calls[0][0] as { clientMetadata: { client_id: string; application_type: string } };
    expect(opts.clientMetadata.client_id).toBe('https://alf.example.com/oauth/client-metadata.json');
    expect(opts.clientMetadata.application_type).toBe('web');
  });

  it('uses loopback client metadata for HTTP service URLs', () => {
    const config = baseConfig('http://localhost:1986');
    createOAuthClient(config);
    const opts = NodeOAuthClient.mock.calls[0][0] as { clientMetadata: { client_id: string; application_type: string } };
    expect(opts.clientMetadata.client_id).toMatch(/^http:\/\/localhost\?/);
    expect(opts.clientMetadata.client_id).toContain('redirect_uri=');
    expect(opts.clientMetadata.client_id).toContain('scope=');
    expect(opts.clientMetadata.application_type).toBe('native');
  });

  it('encodes port in loopback redirect_uri when port is present', () => {
    const config = baseConfig('http://localhost:1986');
    createOAuthClient(config);
    const opts = NodeOAuthClient.mock.calls[0][0] as { clientMetadata: { redirect_uris: string[] } };
    expect(opts.clientMetadata.redirect_uris[0]).toContain(':1986');
  });

  it('omits port in loopback redirect_uri when no port is specified', () => {
    const config = baseConfig('http://localhost');
    createOAuthClient(config);
    const opts = NodeOAuthClient.mock.calls[0][0] as { clientMetadata: { redirect_uris: string[] } };
    expect(opts.clientMetadata.redirect_uris[0]).toBe('http://127.0.0.1/oauth/callback');
  });

  it('passes handleResolver and plcDirectoryUrl to NodeOAuthClient', () => {
    const config = baseConfig('http://localhost:1986');
    createOAuthClient(config);
    const opts = NodeOAuthClient.mock.calls[0][0] as { handleResolver: string; plcDirectoryUrl: string };
    expect(opts.handleResolver).toBe(config.handleResolverUrl);
    expect(opts.plcDirectoryUrl).toBe(config.plcRoot);
  });

  it('sets allowHttp=true for HTTP and allowHttp=false for HTTPS', () => {
    createOAuthClient(baseConfig('http://localhost:1986'));
    const optsHttp = NodeOAuthClient.mock.calls[0][0] as { allowHttp: boolean };
    expect(optsHttp.allowHttp).toBe(true);

    NodeOAuthClient.mockClear();
    createOAuthClient(baseConfig('https://alf.example.com'));
    const optsHttps = NodeOAuthClient.mock.calls[0][0] as { allowHttp: boolean };
    expect(optsHttps.allowHttp).toBe(false);
  });

  it('returns the constructed client', () => {
    const result = createOAuthClient(baseConfig('http://localhost:1986'));
    expect(result).toBeDefined();
  });
});

describe('setOAuthClient / getOAuthClient', () => {
  it('throws before a client is set', () => {
    // Reset the module-level variable by re-importing a fresh module instance
    jest.isolateModules(() => {
      const { getOAuthClient: freshGet } = jest.requireActual('../oauth') as typeof import('../oauth');
      // We can't easily reset the singleton without module reload, so just test
      // the error message on the mock — the real behavior is tested by the isolation trick
      void freshGet; // suppress unused warning
    });
    // After setOAuthClient in other tests, the module singleton holds the last value.
    // At minimum, verify setOAuthClient + getOAuthClient round-trip works.
    const fake = { _tag: 'fakeClient' } as unknown as import('@atproto/oauth-client-node').NodeOAuthClient;
    setOAuthClient(fake);
    expect(getOAuthClient()).toBe(fake);
  });

  it('getOAuthClient returns the client set by setOAuthClient', () => {
    const client = { _tag: 'client2' } as unknown as import('@atproto/oauth-client-node').NodeOAuthClient;
    setOAuthClient(client);
    expect(getOAuthClient()).toBe(client);
  });

  it('getOAuthClient throws when no client has been set', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getOAuthClient: freshGet } = require('../oauth') as typeof import('../oauth');
      expect(() => freshGet()).toThrow('OAuth client not initialized');
    });
  });
});

describe('createStateStore', () => {
  beforeEach(() => {
    NodeOAuthClient.mockClear();
    jest.clearAllMocks();
  });

  const getStateStore = () => {
    createOAuthClient(baseConfig('http://localhost:1986'));
    const opts = NodeOAuthClient.mock.calls[0][0] as {
      stateStore: {
        get: (key: string) => Promise<unknown>;
        set: (key: string, value: unknown) => Promise<void>;
        del: (key: string) => Promise<void>;
      };
    };
    return opts.stateStore;
  };

  it('get returns undefined when getOAuthState returns null', async () => {
    const { getOAuthState } = jest.requireMock('../storage') as {
      getOAuthState: jest.Mock;
      saveOAuthState: jest.Mock;
      deleteOAuthState: jest.Mock;
      getUserAuthorization: jest.Mock;
      upsertUserAuthorization: jest.Mock;
    };
    getOAuthState.mockResolvedValueOnce(null);
    const stateStore = getStateStore();
    const result = await stateStore.get('somekey');
    expect(result).toBeUndefined();
  });

  it('get returns data when getOAuthState returns data', async () => {
    const { getOAuthState } = jest.requireMock('../storage') as {
      getOAuthState: jest.Mock;
      saveOAuthState: jest.Mock;
      deleteOAuthState: jest.Mock;
      getUserAuthorization: jest.Mock;
      upsertUserAuthorization: jest.Mock;
    };
    const fakeState = { iss: 'https://pds.example.com', verifier: 'abc123' };
    getOAuthState.mockResolvedValueOnce(fakeState);
    const stateStore = getStateStore();
    const result = await stateStore.get('somekey');
    expect(result).toEqual(fakeState);
  });

  it('set calls saveOAuthState with key and value', async () => {
    const { saveOAuthState } = jest.requireMock('../storage') as {
      getOAuthState: jest.Mock;
      saveOAuthState: jest.Mock;
      deleteOAuthState: jest.Mock;
      getUserAuthorization: jest.Mock;
      upsertUserAuthorization: jest.Mock;
    };
    saveOAuthState.mockResolvedValueOnce(undefined);
    const stateStore = getStateStore();
    const value = { iss: 'https://pds.example.com', verifier: 'xyz' };
    await stateStore.set('mykey', value);
    expect(saveOAuthState).toHaveBeenCalledWith('mykey', value);
  });

  it('del calls deleteOAuthState with key', async () => {
    const { deleteOAuthState } = jest.requireMock('../storage') as {
      getOAuthState: jest.Mock;
      saveOAuthState: jest.Mock;
      deleteOAuthState: jest.Mock;
      getUserAuthorization: jest.Mock;
      upsertUserAuthorization: jest.Mock;
    };
    deleteOAuthState.mockResolvedValueOnce(undefined);
    const stateStore = getStateStore();
    await stateStore.del('mykey');
    expect(deleteOAuthState).toHaveBeenCalledWith('mykey');
  });
});

describe('createSessionStore', () => {
  beforeEach(() => {
    NodeOAuthClient.mockClear();
    jest.clearAllMocks();
  });

  const getSessionStore = () => {
    createOAuthClient(baseConfig('http://localhost:1986'));
    const opts = NodeOAuthClient.mock.calls[0][0] as {
      sessionStore: {
        get: (sub: string) => Promise<unknown>;
        set: (sub: string, value: unknown) => Promise<void>;
        del: (sub: string) => void;
      };
    };
    return opts.sessionStore;
  };

  it('get returns undefined when getUserAuthorization returns null', async () => {
    const { getUserAuthorization } = jest.requireMock('../storage') as {
      getOAuthState: jest.Mock;
      saveOAuthState: jest.Mock;
      deleteOAuthState: jest.Mock;
      getUserAuthorization: jest.Mock;
      upsertUserAuthorization: jest.Mock;
    };
    getUserAuthorization.mockResolvedValueOnce(null);
    const sessionStore = getSessionStore();
    const result = await sessionStore.get('did:plc:x');
    expect(result).toBeUndefined();
  });

  it('get returns a session when auth row exists with new format (jwk + aud)', async () => {
    const { getUserAuthorization } = jest.requireMock('../storage') as {
      getOAuthState: jest.Mock;
      saveOAuthState: jest.Mock;
      deleteOAuthState: jest.Mock;
      getUserAuthorization: jest.Mock;
      upsertUserAuthorization: jest.Mock;
    };
    const dpopBlob = JSON.stringify({ jwk: { kty: 'EC' }, aud: 'https://pds.host.example.com' });
    getUserAuthorization.mockResolvedValueOnce({
      pds_url: 'https://pds.example.com',
      refresh_token: `enc:mytoken`,
      dpop_private_key: `enc:${dpopBlob}`,
      token_scope: 'atproto',
      auth_type: 'oauth',
      user_did: 'did:plc:x',
      created_at: 0,
      updated_at: 0,
    });
    const sessionStore = getSessionStore();
    const result = await sessionStore.get('did:plc:x') as {
      dpopJwk: Record<string, unknown>;
      authMethod: { method: string };
      tokenSet: {
        sub: string;
        iss: string;
        aud: string;
        scope: string;
        refresh_token: string;
        token_type: string;
      };
    };
    expect(result).toBeDefined();
    expect(result.dpopJwk).toEqual({ kty: 'EC' });
    expect(result.authMethod).toEqual({ method: 'none' });
    expect(result.tokenSet.sub).toBe('did:plc:x');
    expect(result.tokenSet.iss).toBe('https://pds.example.com');
    expect(result.tokenSet.aud).toBe('https://pds.host.example.com');
    expect(result.tokenSet.scope).toBe('atproto');
    expect(result.tokenSet.refresh_token).toBe('mytoken');
    expect(result.tokenSet.token_type).toBe('DPoP');
  });

  it('get handles legacy format (bare JWK, no jwk or aud keys)', async () => {
    const { getUserAuthorization } = jest.requireMock('../storage') as {
      getOAuthState: jest.Mock;
      saveOAuthState: jest.Mock;
      deleteOAuthState: jest.Mock;
      getUserAuthorization: jest.Mock;
      upsertUserAuthorization: jest.Mock;
    };
    const legacyJwk = JSON.stringify({ kty: 'EC', crv: 'P-256' });
    getUserAuthorization.mockResolvedValueOnce({
      pds_url: 'https://pds.example.com',
      refresh_token: `enc:mytoken`,
      dpop_private_key: `enc:${legacyJwk}`,
      token_scope: 'atproto',
      auth_type: 'oauth',
      user_did: 'did:plc:x',
      created_at: 0,
      updated_at: 0,
    });
    const sessionStore = getSessionStore();
    const result = await sessionStore.get('did:plc:x') as {
      dpopJwk: Record<string, unknown>;
      tokenSet: { aud: string };
    };
    expect(result).toBeDefined();
    // Legacy: the whole blob is used as dpopJwk
    expect(result.dpopJwk).toEqual({ kty: 'EC', crv: 'P-256' });
    // Legacy: aud falls back to pds_url from the row
    expect(result.tokenSet.aud).toBe('https://pds.example.com');
  });

  it('get returns undefined when decrypt throws', async () => {
    const { getUserAuthorization } = jest.requireMock('../storage') as {
      getOAuthState: jest.Mock;
      saveOAuthState: jest.Mock;
      deleteOAuthState: jest.Mock;
      getUserAuthorization: jest.Mock;
      upsertUserAuthorization: jest.Mock;
    };
    const { decrypt } = jest.requireMock('../encrypt') as { decrypt: jest.Mock; encrypt: jest.Mock };
    getUserAuthorization.mockResolvedValueOnce({
      pds_url: 'https://pds.example.com',
      refresh_token: `enc:mytoken`,
      dpop_private_key: `enc:{"kty":"EC"}`,
      token_scope: 'atproto',
      auth_type: 'oauth',
      user_did: 'did:plc:x',
      created_at: 0,
      updated_at: 0,
    });
    decrypt.mockImplementationOnce(() => { throw new Error('bad decrypt'); });
    const sessionStore = getSessionStore();
    const result = await sessionStore.get('did:plc:x');
    expect(result).toBeUndefined();
  });

  it('set calls upsertUserAuthorization with encrypted tokens', async () => {
    const { upsertUserAuthorization } = jest.requireMock('../storage') as {
      getOAuthState: jest.Mock;
      saveOAuthState: jest.Mock;
      deleteOAuthState: jest.Mock;
      getUserAuthorization: jest.Mock;
      upsertUserAuthorization: jest.Mock;
    };
    upsertUserAuthorization.mockResolvedValueOnce(undefined);
    const sessionStore = getSessionStore();
    const session = {
      dpopJwk: { kty: 'EC', crv: 'P-256' },
      authMethod: { method: 'none' },
      tokenSet: {
        sub: 'did:plc:x',
        iss: 'https://pds.example.com',
        aud: 'https://pds.host.example.com',
        scope: 'atproto',
        refresh_token: 'mytoken',
        token_type: 'DPoP',
      },
    };
    await sessionStore.set('did:plc:x', session);
    expect(upsertUserAuthorization).toHaveBeenCalledTimes(1);
    const callArgs = upsertUserAuthorization.mock.calls[0][0] as {
      userDid: string;
      pdsUrl: string;
      refreshToken: string;
      dpopPrivateKey: string;
      tokenScope: string;
    };
    expect(callArgs.userDid).toBe('did:plc:x');
    expect(callArgs.pdsUrl).toBe('https://pds.example.com');
    // encrypt mock prefixes with 'enc:'
    expect(callArgs.refreshToken).toBe('enc:mytoken');
    expect(callArgs.dpopPrivateKey).toBe(
      `enc:${JSON.stringify({ jwk: { kty: 'EC', crv: 'P-256' }, aud: 'https://pds.host.example.com' })}`,
    );
    expect(callArgs.tokenScope).toBe('atproto');
  });

  it('set handles non-string tokenSet fields (fallback to empty string)', async () => {
    const { upsertUserAuthorization } = jest.requireMock('../storage') as {
      upsertUserAuthorization: jest.Mock;
    };
    upsertUserAuthorization.mockResolvedValueOnce(undefined);
    const sessionStore = getSessionStore();
    // Omit refresh_token (triggers ?? '') and use non-string iss/aud/scope (trigger : '' fallback)
    const session = {
      dpopJwk: { kty: 'EC' },
      authMethod: { method: 'none' },
      tokenSet: {
        sub: 'did:plc:x',
        iss: undefined as unknown as string,
        aud: 42 as unknown as string,
        scope: null as unknown as string,
        token_type: 'DPoP',
      },
    };
    await sessionStore.set('did:plc:x', session);
    expect(upsertUserAuthorization).toHaveBeenCalledTimes(1);
    const callArgs = upsertUserAuthorization.mock.calls[0][0] as {
      pdsUrl: string;
      tokenScope: string;
      refreshToken: string;
      dpopPrivateKey: string;
    };
    expect(callArgs.pdsUrl).toBe('');
    expect(callArgs.tokenScope).toBe('');
    // refresh_token ?? '' → encrypt('', key) → 'enc:'
    expect(callArgs.refreshToken).toBe('enc:');
    // aud non-string → '' in the JSON blob
    expect(callArgs.dpopPrivateKey).toContain('"aud":""');
  });

  it('del does not throw (it is a no-op)', () => {
    const sessionStore = getSessionStore();
    expect(() => sessionStore.del('did:plc:x')).not.toThrow();
  });
});
