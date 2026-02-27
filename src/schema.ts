// ABOUTME: Kysely database schema types for ALF (Atproto Latency Fabric) service

import { Generated, Selectable } from 'kysely';

export type DraftStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'cancelled';
export type DraftAction = 'create' | 'put' | 'delete';

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
}

export type DraftRow = Selectable<DraftsTable>;
export type UserAuthorizationRow = Selectable<UserAuthorizationsTable>;
export type OAuthStateRow = Selectable<OAuthStatesTable>;
export type DraftBlobRow = Selectable<DraftBlobsTable>;

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
