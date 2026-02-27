// ABOUTME: Background scheduler that polls for ready drafts and publishes them to the PDS

import { Agent } from '@atproto/api';
import type { ServiceConfig } from './config.js';
import { createLogger } from './logger.js';
import { schedulerWakeupsTotal, schedulerPublishesTotal, publishDurationSeconds } from './metrics.js';
import {
  getDb,
  getReadyDrafts,
  getNextScheduledAt,
  claimDraftForPublishing,
  markDraftPublished,
  markDraftFailed,
  incrementRetryCount,
  getDraft,
  getUserAuthorization,
  getBlobsByCids,
  deleteBlobs,
} from './storage.js';
import { getOAuthClient } from './oauth.js';
import type { DraftRow } from './schema.js';
import { extractDidFromAtUri } from './schema.js';

const logger = createLogger('Scheduler');

const MAX_RETRIES = 3;

// Backoff delays for retries (milliseconds)
const RETRY_BACKOFF_MS = [
  1 * 60 * 1000,   // 1 minute
  5 * 60 * 1000,   // 5 minutes
  15 * 60 * 1000,  // 15 minutes
];

let schedulerRunning = false;
let wakeupTimeout: ReturnType<typeof setTimeout> | null = null;
let currentConfig: ServiceConfig | null = null;
let scheduleGeneration = 0;

/**
 * Walk a record JSON and collect all blob CIDs (nodes with { $type: "blob" })
 */
function collectBlobCids(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  const obj = value as Record<string, unknown>;
  if (obj['$type'] === 'blob' && typeof obj['ref'] === 'object' && obj['ref'] !== null) {
    const ref = obj['ref'] as Record<string, unknown>;
    const link = ref['$link'];
    if (typeof link === 'string') return [link];
  }
  return Object.values(obj).flatMap(collectBlobCids);
}

/**
 * Publish a single draft to the user's PDS.
 * This is the shared logic used by both the scheduler and publishPost().
 */
export async function publishDraft(uri: string, config: ServiceConfig): Promise<void> {
  // Atomically claim the draft
  const claimed = await claimDraftForPublishing(uri);
  if (!claimed) {
    logger.warn('Draft already claimed or not in publishable state', { uri });
    return;
  }

  const draft = await getDraft(uri);
  if (!draft) {
    logger.error('Draft not found after claiming', undefined, { uri });
    return;
  }

  logger.info('Publishing draft', { uri, action: draft.action });

  let userDid: string;
  try {
    userDid = extractDidFromAtUri(uri);
  } catch {
    logger.error('Invalid AT-URI in database, skipping draft', undefined, { uri });
    return;
  }
  const publishStart = Date.now();

  try {
    // Look up user authorization — OAuth is the only supported auth type
    const authRecord = await getUserAuthorization(userDid);

    if (!authRecord || authRecord.auth_type !== 'oauth') {
      await markDraftFailed(uri, 'no_oauth_authorization', false);
      logger.error('No OAuth authorization found for user', undefined, { uri, userDid });
      return;
    }

    let agent: Agent;

    // OAuth-type auth: restore OAuth + DPoP session
    const oauthClient = getOAuthClient();
    try {
      const session = await oauthClient.restore(userDid);
      agent = new Agent(session);
    } catch (oauthErr) {
      const errMsg = oauthErr instanceof Error ? oauthErr.message : /* istanbul ignore next */ String(oauthErr);
      if (errMsg.includes('revoked') || errMsg.includes('invalid_grant')) {
        await markDraftFailed(uri, 'oauth_revoked', false);
        logger.error('OAuth token revoked for draft', undefined, { uri });
        return;
      }
      throw oauthErr;
    }

    // Execute the PDS call based on the draft action
    if (draft.action === 'delete') {
      await agent.com.atproto.repo.deleteRecord({
        repo: userDid,
        collection: draft.collection,
        rkey: draft.rkey,
      });
    } else {
      const record = JSON.parse(
        /* istanbul ignore next */ (await getDraftRecord(uri)) ?? '{}',
      ) as Record<string, unknown>;

      // Use scheduled time as the published createdAt so the post appears
      // in the feed at the intended time rather than at draft creation time.
      if (draft.scheduledAt) {
        record.createdAt = draft.scheduledAt;
        record.scheduledAt = draft.scheduledAt;
      }

      // Re-upload any stored blobs before publishing.
      // Blobs are deleted from local storage only AFTER the PDS write succeeds,
      // so that retries can re-upload them if the record commit fails.
      const blobCids = collectBlobCids(record);
      if (blobCids.length > 0) {
        logger.info('Re-uploading blobs for draft', { uri, blobCount: blobCids.length });
        const blobs = await getBlobsByCids(userDid, blobCids);
        for (const blob of blobs) {
          try {
            await agent.uploadBlob(blob.data, { encoding: blob.mimeType });
            logger.info('Blob re-uploaded', { cid: blob.cid });
          } catch (blobErr) {
            logger.warn('Failed to re-upload blob (may already exist on PDS)', { cid: blob.cid });
            // Non-fatal: PDS may already have the blob from a previous attempt
            void blobErr;
          }
        }
      }

      if (draft.action === 'create') {
        await agent.com.atproto.repo.createRecord({
          repo: userDid,
          collection: draft.collection,
          rkey: draft.rkey,
          record,
        });
      } else {
        // put
        await agent.com.atproto.repo.putRecord({
          repo: userDid,
          collection: draft.collection,
          rkey: draft.rkey,
          record,
        });
      }

      // Delete local blob copies now that the record is committed on the PDS
      if (blobCids.length > 0) {
        await deleteBlobs(blobCids);
      }
    }

    await markDraftPublished(uri);
    publishDurationSeconds.observe((Date.now() - publishStart) / 1000);
    schedulerPublishesTotal.inc({ result: 'success' });
    logger.info('Draft published successfully', { uri });

    // Call post-publish webhook if configured
    const webhookUrl = process.env.POST_PUBLISH_WEBHOOK_URL ?? config.postPublishWebhookUrl;
    if (webhookUrl) {
      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uri, publishedAt: new Date().toISOString() }),
        });
      } catch (webhookErr) {
        logger.warn('Post-publish webhook failed (non-fatal)', { uri, error: String(webhookErr) });
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : /* istanbul ignore next */ String(err);
    logger.error('Failed to publish draft', err instanceof Error ? err : /* istanbul ignore next */ undefined, { uri });

    // Increment retry count
    const retryCount = await incrementRetryCount(uri);

    if (retryCount < MAX_RETRIES) {
      const backoffMs = RETRY_BACKOFF_MS[retryCount - 1] ??
        /* istanbul ignore next */ RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
      const retryAt = Date.now() + backoffMs;
      await markDraftFailed(uri, errMsg, true, retryAt);
      schedulerPublishesTotal.inc({ result: 'retry' });
      logger.info('Draft scheduled for retry', { uri, retryCount, retryAt: new Date(retryAt).toISOString() });
    } else {
      await markDraftFailed(uri, errMsg, false);
      schedulerPublishesTotal.inc({ result: 'failed' });
      logger.warn('Draft exhausted retries, marked as failed', { uri, retryCount });
    }
  }
}

/**
 * Get the raw record JSON for a draft (needed for PDS calls)
 */
async function getDraftRecord(uri: string): Promise<string | null> {
  const row = await getDb()
    .selectFrom('drafts')
    .select('record')
    .where('uri', '=', uri)
    .executeTakeFirst();
  /* istanbul ignore next */
  return row?.record ?? null;
}

/**
 * Poll for ready drafts and publish them
 */
async function poll(config: ServiceConfig): Promise<void> {
  schedulerWakeupsTotal.inc();
  let readyDrafts: DraftRow[] = [];
  try {
    readyDrafts = await getReadyDrafts();
  } catch (err) {
    logger.error('Failed to poll for ready drafts', err instanceof Error ? err : /* istanbul ignore next */ undefined);
    return;
  }

  /* istanbul ignore next */
  if (readyDrafts.length === 0) return;

  logger.info(`Found ${readyDrafts.length} draft(s) ready to publish`);

  for (const draft of readyDrafts) {
    try {
      await publishDraft(draft.uri, config);
    } catch (err) /* istanbul ignore next */ {
      logger.error('Unhandled error publishing draft', err instanceof Error ? err : undefined, {
        uri: draft.uri,
      });
    }
  }
}

/**
 * Schedule the next wakeup based on the earliest pending scheduled draft.
 * Cancels any existing wakeup timer before setting the new one.
 */
async function scheduleNextWakeup(): Promise<void> {
  if (wakeupTimeout) {
    clearTimeout(wakeupTimeout);
    wakeupTimeout = null;
  }
  /* istanbul ignore next */
  if (!schedulerRunning || !currentConfig) return;

  const myGen = ++scheduleGeneration;
  const nextAt = await getNextScheduledAt();

  // A newer scheduleNextWakeup() call superseded us while we were awaiting the DB
  if (myGen !== scheduleGeneration) return;
  if (nextAt === null) return;

  const delay = Math.max(0, nextAt - Date.now());
  wakeupTimeout = setTimeout(() => {
    wakeupTimeout = null;
    void poll(currentConfig!).then(() => scheduleNextWakeup());
  }, delay);
  wakeupTimeout.unref();
}

/**
 * Notify the scheduler that the set of scheduled drafts has changed.
 * Recalculates the next wakeup time immediately.
 */
export function notifyScheduler(): void {
  void scheduleNextWakeup();
}

/**
 * Start the background scheduler
 */
export function startScheduler(config: ServiceConfig): void {
  if (schedulerRunning) {
    logger.warn('Scheduler already running');
    return;
  }

  schedulerRunning = true;
  currentConfig = config;
  logger.info('Starting event-driven scheduler');
  void scheduleNextWakeup();
}

/**
 * Stop the background scheduler
 */
export function stopScheduler(): void {
  if (!schedulerRunning) return;
  schedulerRunning = false;
  currentConfig = null;
  scheduleGeneration++; // invalidate any in-flight scheduleNextWakeup() calls
  if (wakeupTimeout) {
    clearTimeout(wakeupTimeout);
    wakeupTimeout = null;
  }
  logger.info('Scheduler stopped');
}
