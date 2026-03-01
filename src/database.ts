// ABOUTME: Kysely database configuration and schema initialization for ALF (Atproto Latency Fabric)

import { Kysely, SqliteDialect, PostgresDialect, Dialect } from 'kysely';
import SQLite from 'better-sqlite3';
import { Pool as PgPool } from 'pg';
import type { Database } from './schema.js';
import type { ServiceConfig } from './config.js';
import { createLogger } from './logger.js';
import path from 'path';
import fs from 'fs';

const logger = createLogger('Database');

/**
 * Create a Kysely dialect based on the configuration
 */
export function createDialect(config: ServiceConfig): Dialect {
  if (config.databaseType === 'postgres') {
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL is required for PostgreSQL');
    }

    const pool = new PgPool({
      connectionString: config.databaseUrl,
      max: 10,
    });

    return new PostgresDialect({ pool });
  }

  // SQLite (default)
  const dbFile = config.databasePath;

  if (dbFile !== ':memory:') {
    const dbDir = path.dirname(dbFile);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
  }

  return new SqliteDialect({
    database: new SQLite(dbFile),
  });
}

/**
 * Create a Kysely database instance
 */
export function createDb(config: ServiceConfig): Kysely<Database> {
  const dialect = createDialect(config);
  return new Kysely<Database>({ dialect });
}

/**
 * Initialize database schema (create tables and indexes)
 */
export async function initializeSchema(db: Kysely<Database>, config: ServiceConfig): Promise<void> {
  const isPostgres = config.databaseType === 'postgres';
  const intType = isPostgres ? 'integer' : 'integer';
  const bigintType = isPostgres ? 'bigint' : 'integer';

  // user_authorizations table
  await db.schema
    .createTable('user_authorizations')
    .ifNotExists()
    .addColumn('user_did', 'text', (col) => col.primaryKey())
    .addColumn('pds_url', 'text', (col) => col.notNull())
    .addColumn('refresh_token', 'text', (col) => col.notNull())
    .addColumn('dpop_private_key', 'text', (col) => col.notNull())
    .addColumn('token_scope', 'text', (col) => col.notNull())
    .addColumn('auth_type', 'text', (col) => col.notNull().defaultTo('oauth'))
    .addColumn('created_at', bigintType as 'integer', (col) => col.notNull())
    .addColumn('updated_at', bigintType as 'integer', (col) => col.notNull())
    .execute();

  // Migrate: add auth_type column to existing user_authorizations table
  try {
    await db.schema
      .alterTable('user_authorizations')
      .addColumn('auth_type', 'text', (col) => col.notNull().defaultTo('oauth'))
      .execute();
  } catch {
    // Column already exists — no-op
  }

  // oauth_states table
  await db.schema
    .createTable('oauth_states')
    .ifNotExists()
    .addColumn('state_key', 'text', (col) => col.primaryKey())
    .addColumn('state_data', 'text', (col) => col.notNull())
    .addColumn('expires_at', bigintType as 'integer', (col) => col.notNull())
    .addColumn('created_at', bigintType as 'integer', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('idx_oauth_states_expires_at')
    .ifNotExists()
    .on('oauth_states')
    .column('expires_at')
    .execute();

  // drafts table
  await db.schema
    .createTable('drafts')
    .ifNotExists()
    .addColumn('uri', 'text', (col) => col.primaryKey())
    .addColumn('user_did', 'text', (col) => col.notNull())
    .addColumn('collection', 'text', (col) => col.notNull())
    .addColumn('rkey', 'text', (col) => col.notNull())
    .addColumn('record', 'text')
    .addColumn('record_cid', 'text')
    .addColumn('action', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('scheduled_at', bigintType as 'integer')
    .addColumn('retry_count', intType as 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', bigintType as 'integer', (col) => col.notNull())
    .addColumn('updated_at', bigintType as 'integer', (col) => col.notNull())
    .addColumn('published_at', bigintType as 'integer')
    .addColumn('failure_reason', 'text')
    .addColumn('trigger_key_hash', 'text')
    .addColumn('trigger_key_encrypted', 'text')
    .addColumn('schedule_id', 'text')
    .execute();

  // Migrations: add trigger and schedule columns to existing drafts table
  for (const col of ['trigger_key_hash', 'trigger_key_encrypted', 'schedule_id']) {
    try {
      await db.schema
        .alterTable('drafts')
        .addColumn(col, 'text')
        .execute();
    } catch {
      // Column already exists — no-op
    }
  }

  await db.schema
    .createIndex('idx_drafts_scheduled_at_status')
    .ifNotExists()
    .on('drafts')
    .columns(['scheduled_at', 'status'])
    .execute();

  await db.schema
    .createIndex('idx_drafts_user_did_status')
    .ifNotExists()
    .on('drafts')
    .columns(['user_did', 'status'])
    .execute();

  // Index for O(1) trigger key lookup
  await db.schema
    .createIndex('idx_drafts_trigger_key_hash')
    .ifNotExists()
    .unique()
    .on('drafts')
    .column('trigger_key_hash')
    .execute();

  // draft_blobs table
  const blobDataType = isPostgres ? 'bytea' : 'blob';
  const idColumnType = isPostgres ? 'serial' : 'integer';
  await db.schema
    .createTable('draft_blobs')
    .ifNotExists()
    .addColumn('id', idColumnType as 'integer', (col) =>
      isPostgres ? col.primaryKey() : col.primaryKey().autoIncrement(),
    )
    .addColumn('user_did', 'text', (col) => col.notNull())
    .addColumn('cid', 'text', (col) => col.notNull())
    .addColumn('data', blobDataType as 'blob')
    .addColumn('mime_type', 'text', (col) => col.notNull())
    .addColumn('size', intType as 'integer', (col) => col.notNull())
    .addColumn('created_at', bigintType as 'integer', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('idx_draft_blobs_user_did_cid')
    .ifNotExists()
    .unique()
    .on('draft_blobs')
    .columns(['user_did', 'cid'])
    .execute();

  // schedules table
  await db.schema
    .createTable('schedules')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('user_did', 'text', (col) => col.notNull())
    .addColumn('collection', 'text', (col) => col.notNull())
    .addColumn('record', 'text')
    .addColumn('content_url', 'text')
    .addColumn('recurrence_rule', 'text', (col) => col.notNull())
    .addColumn('timezone', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('active'))
    .addColumn('fire_count', intType as 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', bigintType as 'integer', (col) => col.notNull())
    .addColumn('updated_at', bigintType as 'integer', (col) => col.notNull())
    .addColumn('last_fired_at', bigintType as 'integer')
    .addColumn('next_draft_uri', 'text')
    .execute();

  await db.schema
    .createIndex('idx_schedules_user_did_status')
    .ifNotExists()
    .on('schedules')
    .columns(['user_did', 'status'])
    .execute();

  logger.info(`${config.databaseType} database schema initialized`);
}
