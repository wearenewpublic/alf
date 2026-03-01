// ABOUTME: Kysely database schema types for ALF (Atproto Latency Fabric) service

import { Generated, Selectable } from 'kysely';

export type DraftStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'cancelled';
export type DraftAction = 'create' | 'put' | 'delete';
export type ScheduleStatus = 'active' | 'paused' | 'cancelled' | 'completed' | 'error';

/**
 * User authorizations table - stores OAuth delegation or session tokens per user
 */
export interface UserAuthorizationsTable {
  user_did: string;
  pds_url: string;
  refresh_token: string;     // Encrypted
  dpop_private_key: string;  // Encrypted DPoP JWK
  token_scope: string;
  auth_type: string;         // always 'oauth'
  created_at: number;
  updated_at: number;
}

/**
 * OAuth states table - temporary PKCE state during OAuth flow
 */
export interface OAuthStatesTable {
  state_key: string;
  state_data: string;  // JSON blob: {codeVerifier, dpopJwk, handle, redirectUri}
  expires_at: number;
  created_at: number;
}

/**
 * Drafts table - stores draft/scheduled ATProto record operations
 */
export interface DraftsTable {
  uri: string;          // AT-URI: at://did/collection/rkey (PRIMARY KEY)
  user_did: string;     // FK → user_authorizations
  collection: string;   // NSID
  rkey: string;         // Record key
  record: string | null;       // JSON blob (null for deleteRecord drafts)
  record_cid: string | null;   // Pre-computed DAG-CBOR CID (null for deleteRecord drafts)
  action: DraftAction;
  status: DraftStatus;
  scheduled_at: number | null; // Unix timestamp; null = unscheduled draft
  retry_count: Generated<number>;
  created_at: number;
  updated_at: number;
  published_at: number | null;
  failure_reason: string | null;
  trigger_key_hash: string | null;      // HMAC-SHA256 of plaintext key for O(1) lookup
  trigger_key_encrypted: string | null; // AES-256-GCM encrypted plaintext key for retrieval
  schedule_id: string | null;           // FK → schedules(id), null if not part of a schedule
}

/**
 * Schedules table - stores recurrence rules for recurring posts
 */
export interface SchedulesTable {
  id: string;                  // UUID (PRIMARY KEY)
  user_did: string;
  collection: string;          // NSID (e.g. app.bsky.feed.post)
  record: string | null;       // Static JSON record, null if content_url used
  content_url: string | null;  // Dynamic content URL, null if record used
  recurrence_rule: string;     // Full JSON (RecurrenceRule schema)
  timezone: string;            // IANA timezone (extracted from rule for indexing)
  status: ScheduleStatus;
  fire_count: number;
  created_at: number;
  updated_at: number;
  last_fired_at: number | null;
  next_draft_uri: string | null; // AT-URI of pending draft instance
}

/**
 * Draft blobs table - stores raw image bytes for scheduled posts
 */
export interface DraftBlobsTable {
  id: Generated<number>;
  user_did: string;
  cid: string;           // Content-addressed CID
  data: Buffer;          // Raw blob bytes
  mime_type: string;
  size: number;
  created_at: number;
}

/**
 * Database schema interface
 */
export interface Database {
  user_authorizations: UserAuthorizationsTable;
  oauth_states: OAuthStatesTable;
  drafts: DraftsTable;
  draft_blobs: DraftBlobsTable;
  schedules: SchedulesTable;
}

export type DraftRow = Selectable<DraftsTable>;
export type UserAuthorizationRow = Selectable<UserAuthorizationsTable>;
export type OAuthStateRow = Selectable<OAuthStatesTable>;
export type DraftBlobRow = Selectable<DraftBlobsTable>;
export type ScheduleRow = Selectable<SchedulesTable>;

/**
 * Public draft view (returned to clients)
 */
export interface DraftView {
  uri: string;
  cid?: string;
  collection: string;
  rkey: string;
  action: DraftAction;
  status: DraftStatus;
  scheduledAt?: string;
  createdAt: string;
  failureReason?: string;
  record?: Record<string, unknown>;
  triggerUrl?: string;   // Only present for webhook-triggered drafts (populated by server)
  scheduleId?: string;   // Only present for schedule-linked drafts
}

/**
 * Public schedule view (returned to clients)
 */
export interface ScheduleView {
  id: string;
  collection: string;
  status: ScheduleStatus;
  recurrenceRule: Record<string, unknown>;
  timezone: string;
  fireCount: number;
  createdAt: string;
  updatedAt: string;
  lastFiredAt?: string;
  nextDraftUri?: string;
  contentUrl?: string;
  record?: Record<string, unknown>;
}

/**
 * Convert a DraftRow to a DraftView
 */
export function rowToDraftView(row: DraftRow): DraftView {
  return {
    uri: row.uri,
    cid: row.record_cid || undefined,
    collection: row.collection,
    rkey: row.rkey,
    action: row.action,
    status: row.status,
    scheduledAt: row.scheduled_at
      ? new Date(Number(row.scheduled_at)).toISOString()
      : undefined,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    failureReason: row.failure_reason || undefined,
    record: row.record ? (JSON.parse(row.record) as Record<string, unknown>) : undefined,
    scheduleId: row.schedule_id || undefined,
  };
}

/**
 * Convert a ScheduleRow to a ScheduleView
 */
export function rowToScheduleView(row: ScheduleRow): ScheduleView {
  return {
    id: row.id,
    collection: row.collection,
    status: row.status,
    recurrenceRule: JSON.parse(row.recurrence_rule) as Record<string, unknown>,
    timezone: row.timezone,
    fireCount: Number(row.fire_count),
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
    lastFiredAt: row.last_fired_at ? new Date(Number(row.last_fired_at)).toISOString() : undefined,
    nextDraftUri: row.next_draft_uri || undefined,
    contentUrl: row.content_url || undefined,
    record: row.record ? (JSON.parse(row.record) as Record<string, unknown>) : undefined,
  };
}

/**
 * Extract the DID from an AT-URI (at://DID/collection/rkey).
 * Throws if the URI is not a valid AT-URI format.
 */
export function extractDidFromAtUri(uri: string): string {
  const match = /^at:\/\/(did:[^/]+)\//.exec(uri);
  if (!match?.[1]) {
    throw new Error(`Invalid AT-URI: ${uri}`);
  }
  return match[1];
}
