// Tests for configuration loading and validation

import { getConfig } from '../config';

describe('getConfig', () => {
  const VALID_KEY = 'a'.repeat(64);

  // Save and restore env vars around each test
  let savedEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    savedEnv = { ...process.env };
    // Clear all relevant env vars before each test
    delete process.env.ALF_PORT;
    delete process.env.PORT;
    delete process.env.ALF_SERVICE_URL;
    delete process.env.SERVICE_URL;
    delete process.env.PLC_ROOT;
    delete process.env.HANDLE_RESOLVER_URL;
    delete process.env.PDS_URL;
    delete process.env.DATABASE_TYPE;
    delete process.env.DATABASE_PATH;
    delete process.env.DATABASE_URL;
    delete process.env.ENCRYPTION_KEY;
    delete process.env.POST_PUBLISH_WEBHOOK_URL;
    delete process.env.MAX_DRAFTS_PER_USER;
  });
  afterEach(() => {
    process.env = savedEnv;
  });

  it('returns defaults when only ENCRYPTION_KEY is set', () => {
    process.env.ENCRYPTION_KEY = VALID_KEY;
    const cfg = getConfig();
    expect(cfg.port).toBe(1986);
    expect(cfg.serviceUrl).toBe('http://localhost:1986');
    expect(cfg.plcRoot).toBe('https://plc.directory');
    expect(cfg.handleResolverUrl).toBe('https://api.bsky.app');
    expect(cfg.databaseType).toBe('sqlite');
    expect(cfg.databasePath).toBe('./data/alf.db');
    expect(cfg.databaseUrl).toBeUndefined();
    expect(cfg.encryptionKey).toBe(VALID_KEY);
    expect(cfg.postPublishWebhookUrl).toBeUndefined();
    expect(cfg.maxDraftsPerUser).toBeNull();
  });

  it('reads MAX_DRAFTS_PER_USER as a number', () => {
    process.env.ENCRYPTION_KEY = VALID_KEY;
    process.env.MAX_DRAFTS_PER_USER = '5';
    expect(getConfig().maxDraftsPerUser).toBe(5);
  });

  it('leaves maxDraftsPerUser as null when MAX_DRAFTS_PER_USER is unset', () => {
    process.env.ENCRYPTION_KEY = VALID_KEY;
    expect(getConfig().maxDraftsPerUser).toBeNull();
  });

  it('reads ALF_PORT', () => {
    process.env.ENCRYPTION_KEY = VALID_KEY;
    process.env.ALF_PORT = '4000';
    expect(getConfig().port).toBe(4000);
  });

  it('falls back to PORT when ALF_PORT is absent', () => {
    process.env.ENCRYPTION_KEY = VALID_KEY;
    process.env.PORT = '5000';
    expect(getConfig().port).toBe(5000);
  });

  it('reads ALF_SERVICE_URL', () => {
    process.env.ENCRYPTION_KEY = VALID_KEY;
    process.env.ALF_SERVICE_URL = 'https://alf.example.com';
    expect(getConfig().serviceUrl).toBe('https://alf.example.com');
  });

  it('falls back to SERVICE_URL', () => {
    process.env.ENCRYPTION_KEY = VALID_KEY;
    process.env.SERVICE_URL = 'https://fallback.example.com';
    expect(getConfig().serviceUrl).toBe('https://fallback.example.com');
  });

  it('reads PLC_ROOT', () => {
    process.env.ENCRYPTION_KEY = VALID_KEY;
    process.env.PLC_ROOT = 'https://plc.custom.example';
    expect(getConfig().plcRoot).toBe('https://plc.custom.example');
  });

  it('reads HANDLE_RESOLVER_URL', () => {
    process.env.ENCRYPTION_KEY = VALID_KEY;
    process.env.HANDLE_RESOLVER_URL = 'https://handle.example.com';
    expect(getConfig().handleResolverUrl).toBe('https://handle.example.com');
  });

  it('falls back to PDS_URL for handle resolver', () => {
    process.env.ENCRYPTION_KEY = VALID_KEY;
    process.env.PDS_URL = 'https://pds.example.com';
    expect(getConfig().handleResolverUrl).toBe('https://pds.example.com');
  });

  it('reads DATABASE_PATH', () => {
    process.env.ENCRYPTION_KEY = VALID_KEY;
    process.env.DATABASE_PATH = '/custom/path/alf.db';
    expect(getConfig().databasePath).toBe('/custom/path/alf.db');
  });

  it('reads POST_PUBLISH_WEBHOOK_URL', () => {
    process.env.ENCRYPTION_KEY = VALID_KEY;
    process.env.POST_PUBLISH_WEBHOOK_URL = 'https://webhook.example.com/hook';
    expect(getConfig().postPublishWebhookUrl).toBe('https://webhook.example.com/hook');
  });

  it('throws when DATABASE_TYPE is postgres and DATABASE_URL is missing', () => {
    process.env.ENCRYPTION_KEY = VALID_KEY;
    process.env.DATABASE_TYPE = 'postgres';
    expect(() => getConfig()).toThrow('DATABASE_URL is required');
  });

  it('succeeds when DATABASE_TYPE is postgres and DATABASE_URL is set', () => {
    process.env.ENCRYPTION_KEY = VALID_KEY;
    process.env.DATABASE_TYPE = 'postgres';
    process.env.DATABASE_URL = 'postgres://user:pass@localhost/db';
    const cfg = getConfig();
    expect(cfg.databaseType).toBe('postgres');
    expect(cfg.databaseUrl).toBe('postgres://user:pass@localhost/db');
  });

  it('throws when ENCRYPTION_KEY is missing', () => {
    expect(() => getConfig()).toThrow('ENCRYPTION_KEY is required');
  });

  it('throws when ENCRYPTION_KEY is not 64 hex chars', () => {
    process.env.ENCRYPTION_KEY = 'tooshort';
    expect(() => getConfig()).toThrow('ENCRYPTION_KEY must be a 64-character hex string');
  });

  it('throws when ENCRYPTION_KEY is 64 chars but not valid hex', () => {
    process.env.ENCRYPTION_KEY = 'z'.repeat(64); // 'z' is not valid hex
    expect(() => getConfig()).toThrow('ENCRYPTION_KEY must be a 64-character hex string');
  });
});
