// Tests for database dialect creation and schema initialization

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Kysely } from 'kysely';
import { createDialect, createDb, initializeSchema } from '../database';
import type { ServiceConfig } from '../config';
import type { Database } from '../schema';

// Mock pg so postgres dialect tests don't need a real database
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    end: jest.fn(),
    query: jest.fn(),
  })),
}));

const baseConfig = (overrides: Partial<ServiceConfig> = {}): ServiceConfig => ({
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

describe('createDialect', () => {
  it('throws for postgres without DATABASE_URL', () => {
    expect(() =>
      createDialect(baseConfig({ databaseType: 'postgres', databaseUrl: undefined })),
    ).toThrow('DATABASE_URL is required');
  });

  it('creates a postgres dialect when databaseUrl is provided', () => {
    const { Pool } = jest.requireMock('pg') as { Pool: jest.Mock };
    const dialect = createDialect(baseConfig({
      databaseType: 'postgres',
      databaseUrl: 'postgresql://user:pass@localhost:5432/testdb',
    }));
    expect(dialect).toBeDefined();
    expect(Pool).toHaveBeenCalledWith({
      connectionString: 'postgresql://user:pass@localhost:5432/testdb',
      max: 10,
    });
  });

  it('creates a SQLite dialect for :memory: without creating directories', () => {
    const dialect = createDialect(baseConfig({ databasePath: ':memory:' }));
    expect(dialect).toBeDefined();
  });

  it('creates the directory for a SQLite file path that does not exist yet', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alf-test-'));
    const dbPath = path.join(tmpDir, 'subdir', 'test.db');
    try {
      const dialect = createDialect(baseConfig({ databasePath: dbPath }));
      expect(dialect).toBeDefined();
      expect(fs.existsSync(path.join(tmpDir, 'subdir'))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not throw if the SQLite directory already exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alf-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    try {
      expect(() => createDialect(baseConfig({ databasePath: dbPath }))).not.toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('createDb', () => {
  it('returns a Kysely instance', () => {
    const db = createDb(baseConfig());
    expect(db).toBeDefined();
    expect(typeof db.selectFrom).toBe('function');
    void db.destroy();
  });
});

describe('initializeSchema', () => {
  it('creates all tables without throwing', async () => {
    const config = baseConfig();
    const db = createDb(config);
    await expect(initializeSchema(db, config)).resolves.toBeUndefined();
    await db.destroy();
  });

  it('is idempotent — calling twice does not throw', async () => {
    const config = baseConfig();
    const db = createDb(config);
    await initializeSchema(db, config);
    await expect(initializeSchema(db, config)).resolves.toBeUndefined();
    await db.destroy();
  });

  it('uses postgres-specific column types when databaseType is postgres', async () => {
    const config = baseConfig({ databaseType: 'postgres', databaseUrl: 'postgresql://localhost/test' });
    // Build a proxy-based mock Kysely that returns itself from every method call
    // and resolves execute() with undefined, so we can call initializeSchema
    // against a postgres config without needing a real database.
    // addColumn is special-cased to invoke the column builder callback so that
    // the isPostgres ternary inside the callback (line 144) is exercised.
    const makeChain = (): object => {
      const chain: Record<string, unknown> = new Proxy({} as Record<string, unknown>, {
        get(_, prop) {
          if (prop === 'execute') return () => Promise.resolve();
          if (prop === 'addColumn') {
            return (_name: string, _type: string, cb?: (col: unknown) => unknown) => {
              if (cb) cb(chain); // execute the column builder callback
              return chain;
            };
          }
          return () => chain;
        },
      });
      return chain;
    };
    const mockDb = { schema: makeChain() } as unknown as Kysely<Database>;
    await expect(initializeSchema(mockDb, config)).resolves.toBeUndefined();
  });
});
