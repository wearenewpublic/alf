// ABOUTME: Database operations for ALF (Atproto Latency Fabric) service (drafts CRUD, user authorizations, blob storage)

import { Kysely } from 'kysely';
import type { Database, DraftView, DraftRow, DraftAction, DraftStatus } from './schema.js';
import { rowToDraftView } from './schema.js';
import { createLogger } from './logger.js';

const logger = createLogger('Storage');

let db: Kysely<Database> | null = null;

export function setDb(database: Kysely<Database>): void {
  db = database;
}

export function getDb(): Kysely<Database> {
  /* istanbul ignore next */
  if (!db) throw new Error('Database not initialized');
  return db;
}

// ---- Draft Operations ----

export interface CreateDraftParams {
  uri: string;
  userDid: string;
  collection: string;
  rkey: string;
  record: Record<string, unknown> | null;
  recordCid: string | null;
  action: DraftAction;
  scheduledAt?: number;
}

export async function createDraft(params: CreateDraftParams): Promise<DraftView> {
  const now = Date.now();
  const status: DraftStatus = params.scheduledAt ? 'scheduled' : 'draft';

  // Check if an active draft already exists for this AT-URI
  const existing = await getDb()
    .selectFrom('drafts')
    .select('status')
    .where('uri', '=', params.uri)
    .executeTakeFirst();

  if (existing) {
    const activeStatuses = ['draft', 'scheduled', 'publishing'];
    if (activeStatuses.includes(existing.status)) {
      throw Object.assign(new Error(`An active draft already exists for URI: ${params.uri}`), {
        code: 'DuplicateDraft',
      });
    }
    // Previous draft was published/cancelled/failed — delete it so we can re-use the URI
    await getDb().deleteFrom('drafts').where('uri', '=', params.uri).execute();
  }

  await getDb()
    .insertInto('drafts')
    .values({
      uri: params.uri,
      user_did: params.userDid,
      collection: params.collection,
      rkey: params.rkey,
      record: params.record ? JSON.stringify(params.record) : null,
      record_cid: params.recordCid,
      action: params.action,
      status,
      scheduled_at: params.scheduledAt ?? null,
      created_at: now,
      updated_at: now,
      published_at: null,
      failure_reason: null,
    })
    .execute();

  logger.info('Draft created', { uri: params.uri, action: params.action, status });

  const row = await getDraftRow(params.uri);
  return rowToDraftView(row);
}

export async function getDraft(uri: string): Promise<DraftView | null> {
  const row = await getDb()
    .selectFrom('drafts')
    .selectAll()
    .where('uri', '=', uri)
    .executeTakeFirst();

  return row ? rowToDraftView(row) : null;
}

async function getDraftRow(uri: string): Promise<DraftRow> {
  const row = await getDb()
    .selectFrom('drafts')
    .selectAll()
    .where('uri', '=', uri)
    .executeTakeFirstOrThrow();
  return row;
}

export async function listDrafts(params: {
  userDid: string;
  status?: string;
  limit: number;
  cursor?: string;
}): Promise<{ drafts: DraftView[]; cursor?: string }> {
  let query = getDb()
    .selectFrom('drafts')
    .selectAll()
    .where('user_did', '=', params.userDid);

  if (params.status === 'scheduled') {
    query = query.orderBy('scheduled_at', 'asc');
  } else {
    query = query.orderBy('created_at', 'desc');
  }

  if (params.status) {
    query = query.where('status', '=', params.status as DraftStatus);
  }

  if (params.cursor) {
    const cursorTime = parseInt(params.cursor, 10);
    if (params.status === 'scheduled') {
      query = query.where('scheduled_at', '>', cursorTime);
    } else {
      query = query.where('created_at', '<', cursorTime);
    }
  }

  query = query.limit(params.limit + 1);

  const rows = await query.execute();

  let nextCursor: string | undefined;
  if (rows.length > params.limit) {
    rows.pop();
    const lastRow = rows[rows.length - 1];
    if (lastRow) {
      nextCursor =
        params.status === 'scheduled'
          ? String(lastRow.scheduled_at)
          : String(lastRow.created_at);
    }
  }

  return {
    drafts: rows.map(rowToDraftView),
    cursor: nextCursor,
  };
}

export async function scheduleDraft(uri: string, publishAt: number): Promise<DraftView | null> {
  const now = Date.now();
  await getDb()
    .updateTable('drafts')
    .set({
      scheduled_at: publishAt,
      status: 'scheduled',
      updated_at: now,
    })
    .where('uri', '=', uri)
    .where('status', 'in', ['draft', 'scheduled'])
    .execute();

  return getDraft(uri);
}

export async function updateDraft(uri: string, params: {
  record?: Record<string, unknown>;
  recordCid?: string;
  scheduledAt?: number;
}): Promise<DraftView | null> {
  const now = Date.now();
  const updates: Partial<{
    record: string | null;
    record_cid: string | null;
    scheduled_at: number | null;
    status: DraftStatus;
    updated_at: number;
  }> = { updated_at: now };

  if (params.record !== undefined) {
    updates.record = JSON.stringify(params.record);
    updates.record_cid = params.recordCid ?? null;
  }
  if (params.scheduledAt !== undefined) {
    updates.scheduled_at = params.scheduledAt;
    updates.status = 'scheduled';
  }

  await getDb()
    .updateTable('drafts')
    .set(updates)
    .where('uri', '=', uri)
    .where('status', 'in', ['draft', 'scheduled'])
    .execute();

  return getDraft(uri);
}

export async function cancelDraft(uri: string): Promise<void> {
  const now = Date.now();
  await getDb()
    .updateTable('drafts')
    .set({ status: 'cancelled', updated_at: now })
    .where('uri', '=', uri)
    .where('status', 'in', ['draft', 'scheduled'])
    .execute();
}

/**
 * Atomically claim a draft for publishing (set status to 'publishing').
 * Returns true if the draft was claimed, false if it was already claimed or doesn't exist.
 */
export async function claimDraftForPublishing(uri: string): Promise<boolean> {
  const now = Date.now();
  const result = await getDb()
    .updateTable('drafts')
    .set({ status: 'publishing', updated_at: now })
    .where('uri', '=', uri)
    .where('status', 'in', ['draft', 'scheduled'])
    .executeTakeFirst();

  return Number(result.numUpdatedRows) > 0;
}

export async function markDraftPublished(uri: string): Promise<void> {
  const now = Date.now();
  await getDb()
    .updateTable('drafts')
    .set({ status: 'published', published_at: now, updated_at: now })
    .where('uri', '=', uri)
    .execute();
}

export async function markDraftFailed(
  uri: string,
  reason: string,
  resetToScheduled: boolean,
  scheduledAt?: number,
): Promise<void> {
  const now = Date.now();
  if (resetToScheduled && scheduledAt) {
    await getDb()
      .updateTable('drafts')
      .set({
        status: 'scheduled',
        scheduled_at: scheduledAt,
        failure_reason: reason,
        updated_at: now,
      })
      .where('uri', '=', uri)
      .execute();
  } else {
    await getDb()
      .updateTable('drafts')
      .set({
        status: 'failed',
        failure_reason: reason,
        updated_at: now,
      })
      .where('uri', '=', uri)
      .execute();
  }
}

export async function incrementRetryCount(uri: string): Promise<number> {
  await getDb()
    .updateTable('drafts')
    .set((eb) => ({ retry_count: eb('retry_count', '+', 1) }))
    .where('uri', '=', uri)
    .execute();

  const row = await getDraftRow(uri);
  return row.retry_count;
}

/**
 * Count active (non-terminal) drafts for a user.
 * Active statuses are: 'draft', 'scheduled', 'publishing'.
 */
export async function countActiveDraftsForUser(repo: string): Promise<number> {
  const result = await getDb()
    .selectFrom('drafts')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('user_did', '=', repo)
    .where('status', 'not in', ['published', 'failed', 'cancelled'])
    .executeTakeFirstOrThrow();
  return Number(result.count);
}

/**
 * Returns the earliest scheduled_at timestamp among pending scheduled drafts, or null if none.
 */
export async function getNextScheduledAt(): Promise<number | null> {
  const row = await getDb()
    .selectFrom('drafts')
    .select('scheduled_at')
    .where('status', '=', 'scheduled')
    .where('scheduled_at', 'is not', null)
    .orderBy('scheduled_at', 'asc')
    .limit(1)
    .executeTakeFirst();
  return row?.scheduled_at != null ? Number(row.scheduled_at) : null;
}

/**
 * Get all drafts ready to publish (status=scheduled, scheduled_at <= now)
 */
export async function getReadyDrafts(): Promise<DraftRow[]> {
  const now = Date.now();
  return getDb()
    .selectFrom('drafts')
    .selectAll()
    .where('status', '=', 'scheduled')
    .where('scheduled_at', '<=', now)
    .execute();
}

// ---- User Authorization Operations ----

export interface UpsertAuthParams {
  userDid: string;
  pdsUrl: string;
  refreshToken: string;
  dpopPrivateKey: string;
  tokenScope: string;
}

export async function upsertUserAuthorization(params: UpsertAuthParams): Promise<void> {
  const now = Date.now();
  await getDb()
    .insertInto('user_authorizations')
    .values({
      user_did: params.userDid,
      pds_url: params.pdsUrl,
      refresh_token: params.refreshToken,
      dpop_private_key: params.dpopPrivateKey,
      token_scope: params.tokenScope,
      auth_type: 'oauth',
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.column('user_did').doUpdateSet({
        pds_url: params.pdsUrl,
        refresh_token: params.refreshToken,
        dpop_private_key: params.dpopPrivateKey,
        token_scope: params.tokenScope,
        updated_at: now,
      }),
    )
    .execute();
}

export async function getUserAuthorization(userDid: string) {
  return getDb()
    .selectFrom('user_authorizations')
    .selectAll()
    .where('user_did', '=', userDid)
    .executeTakeFirst();
}

/**
 * Delete all data associated with a user: cancels active drafts and removes their authorization.
 */
export async function deleteUserData(userDid: string): Promise<void> {
  const now = Date.now();
  await getDb()
    .updateTable('drafts')
    .set({ status: 'cancelled', updated_at: now })
    .where('user_did', '=', userDid)
    .where('status', 'in', ['draft', 'scheduled'])
    .execute();
  await getDb()
    .deleteFrom('user_authorizations')
    .where('user_did', '=', userDid)
    .execute();
}

// ---- Draft Blob Operations ----

/**
 * Store a draft blob (raw image bytes) for a user
 */
export async function storeDraftBlob(
  userDid: string,
  cid: string,
  data: Buffer,
  mimeType: string,
  size: number,
): Promise<void> {
  const now = Date.now();
  await getDb()
    .insertInto('draft_blobs')
    .values({
      user_did: userDid,
      cid,
      data,
      mime_type: mimeType,
      size,
      created_at: now,
    })
    // Use doNothing() rather than targeting columns: SQLite only allows
    // ON CONFLICT (cols) DO UPDATE SET when those cols are declared with an
    // inline UNIQUE constraint — a separately-created UNIQUE INDEX is not
    // sufficient. Since CIDs are content-addressed, a duplicate upload is
    // identical data, so ignoring the conflict is semantically correct.
    .onConflict((oc) => oc.doNothing())
    .execute();
}

/**
 * Fetch blobs by CIDs for a user
 */
export async function getBlobsByCids(
  userDid: string,
  cids: string[],
): Promise<Array<{ cid: string; data: Buffer; mimeType: string }>> {
  if (cids.length === 0) return [];
  const rows = await getDb()
    .selectFrom('draft_blobs')
    .select(['cid', 'data', 'mime_type'])
    .where('user_did', '=', userDid)
    .where('cid', 'in', cids)
    .execute();
  return rows.map((r) => ({
    cid: r.cid,
    data: Buffer.from(r.data),
    mimeType: r.mime_type,
  }));
}

/**
 * Delete blobs by CIDs (called after successful publish)
 */
export async function deleteBlobs(cids: string[]): Promise<void> {
  if (cids.length === 0) return;
  await getDb()
    .deleteFrom('draft_blobs')
    .where('cid', 'in', cids)
    .execute();
}

// ---- OAuth State Operations ----

export async function saveOAuthState(stateKey: string, stateData: object): Promise<void> {
  const now = Date.now();
  const expiresAt = now + 10 * 60 * 1000; // 10 minutes
  await getDb()
    .insertInto('oauth_states')
    .values({
      state_key: stateKey,
      state_data: JSON.stringify(stateData),
      expires_at: expiresAt,
      created_at: now,
    })
    .execute();
}

export async function getOAuthState(stateKey: string): Promise<object | null> {
  const now = Date.now();
  const row = await getDb()
    .selectFrom('oauth_states')
    .selectAll()
    .where('state_key', '=', stateKey)
    .where('expires_at', '>', now)
    .executeTakeFirst();

  if (!row) return null;
  return JSON.parse(row.state_data) as object;
}

export async function deleteOAuthState(stateKey: string): Promise<void> {
  await getDb()
    .deleteFrom('oauth_states')
    .where('state_key', '=', stateKey)
    .execute();
}

export async function cleanExpiredOAuthStates(): Promise<void> {
  const now = Date.now();
  await getDb()
    .deleteFrom('oauth_states')
    .where('expires_at', '<=', now)
    .execute();
}
