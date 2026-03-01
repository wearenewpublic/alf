// ABOUTME: Background scheduler that polls for ready drafts and publishes them to the PDS

import { Agent } from '@atproto/api';
import { randomUUID } from 'node:crypto';
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
  getDraftRawRow,
  getUserAuthorization,
  getBlobsByCids,
  deleteBlobs,
  getRawSchedule,
  incrementScheduleFireCount,
  updateScheduleNextDraft,
  updateScheduleStatus,
  createDraft,
} from './storage.js';
import { getOAuthClient } from './oauth.js';
import type { DraftRow } from './schema.js';
import { extractDidFromAtUri } from './schema.js';
import { computeNextOccurrence, getOccurrenceRecord } from '@newpublic/recurrence';
import type { RecurrenceRule } from '@newpublic/recurrence';

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
 * After a successful publish, handle schedule chaining:
 * increment fire_count, compute next occurrence, create next draft.
 */
async function handleScheduleChaining(draftRow: DraftRow): Promise<void> {
  const scheduleId = draftRow.schedule_id;
  /* istanbul ignore next */
  if (!scheduleId) return;

  const schedule = await getRawSchedule(scheduleId);
  if (!schedule || schedule.status !== 'active') return;

  const userDid = draftRow.user_did;
  const now = new Date();

  // If dynamic content, fetch it (just for logging — it was already published)
  if (schedule.content_url) {
    try {
      const url = new URL(schedule.content_url);
      url.searchParams.set('fireCount', String(schedule.fire_count + 1));
      url.searchParams.set('scheduledAt', new Date(Number(draftRow.scheduled_at ?? /* istanbul ignore next */ Date.now())).toISOString());
      logger.info('Dynamic schedule published', { scheduleId, contentUrl: url.toString() });
    } catch (err) {
      /* istanbul ignore next */
      logger.warn('Failed to build content URL for logging', { scheduleId, error: String(err) });
    }
  }

  // Increment fire count
  await incrementScheduleFireCount(scheduleId);

  // Compute next occurrence
  let rule: RecurrenceRule;
  try {
    rule = JSON.parse(schedule.recurrence_rule) as RecurrenceRule;
  } catch {
    logger.error('Invalid recurrence rule JSON in schedule', undefined, { scheduleId });
    await updateScheduleStatus(scheduleId, 'error');
    return;
  }

  const nextFireAt = computeNextOccurrence(rule, now);
  if (!nextFireAt) {
    // Series exhausted — 'once' schedules complete naturally; others are cancelled
    const isOnce = rule.rule.type === 'once';
    if (isOnce) {
      logger.info('Once schedule completed, marking completed', { scheduleId });
      await updateScheduleStatus(scheduleId, 'completed');
    } else {
      logger.info('Schedule series exhausted, marking cancelled', { scheduleId });
      await updateScheduleStatus(scheduleId, 'cancelled');
    }
    await updateScheduleNextDraft(scheduleId, null);
    return;
  }

  // For dynamic schedules, create a draft with null record (fetched at publish time)
  // For static schedules, create a draft with the template record
  const nextRecord = schedule.content_url ? null : (schedule.record ? JSON.parse(schedule.record) as Record<string, unknown> : /* istanbul ignore next */ null);

  // Build AT-URI for next draft
  const rkey = `sched-${Date.now()}-${randomUUID().substring(0, 8)}`;
  const collection = schedule.collection;
  const uri = `at://${userDid}/${collection}/${rkey}`;

  try {
    await createDraft({
      uri,
      userDid,
      collection,
      rkey,
      record: nextRecord,
      recordCid: null, // Will be computed at publish time for static records
      action: 'create',
      scheduledAt: nextFireAt.getTime(),
      scheduleId,
    });

    await updateScheduleNextDraft(scheduleId, uri);
    notifyScheduler();
    logger.info('Next scheduled draft created', { scheduleId, uri, nextFireAt: nextFireAt.toISOString() });
  } catch (err) {
    logger.error('Failed to create next schedule draft', err instanceof Error ? err : /* istanbul ignore next */ undefined, { scheduleId });
    await updateScheduleStatus(scheduleId, 'error');
  }
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
      const errCode = (oauthErr as { error?: string }).error ?? '';
      // OAuthResponseError from a failed token refresh has .error on the cause
      const causeCode = ((oauthErr as { cause?: { error?: string } }).cause?.error) ?? '';
      const isPermanentAuthFailure =
        errMsg.includes('revoked') ||
        errMsg.includes('invalid_grant') ||
        errCode === 'invalid_token' ||
        errMsg.includes('invalid_token') ||
        causeCode === 'invalid_grant' ||
        // TokenRefreshError wraps the underlying OAuth error
        errMsg.toLowerCase().includes('token refresh') ||
        errMsg.toLowerCase().includes('refresh failed');
      if (isPermanentAuthFailure) {
        await markDraftFailed(uri, 'oauth_revoked', false);
        logger.error('OAuth token revoked or refresh failed for draft', undefined, { uri, errMsg, errCode, causeCode });
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
      // For dynamic schedule drafts, fetch content from content_url at publish time
      let record: Record<string, unknown>;
      const draftRaw = await getDraftRawRow(uri);
      const scheduleId = draftRaw?.schedule_id;

      if (scheduleId && !draftRaw?.record) {
        // Dynamic schedule: fetch content URL
        const schedule = await getRawSchedule(scheduleId);
        if (!schedule?.content_url) {
          await markDraftFailed(uri, 'dynamic_schedule_missing_content_url', false);
          return;
        }
        try {
          const url = new URL(schedule.content_url);
          url.searchParams.set('fireCount', String(schedule.fire_count + 1));
          url.searchParams.set('scheduledAt', new Date(Number(draftRaw?.scheduled_at ?? /* istanbul ignore next */ Date.now())).toISOString());
          const resp = await fetch(url.toString(), {
            headers: { 'Accept': 'application/json' },
          });
          if (!resp.ok) {
            throw new Error(`Content URL returned ${resp.status}`);
          }
          record = await resp.json() as Record<string, unknown>;
        } catch (fetchErr) {
          const errMsg = fetchErr instanceof Error ? fetchErr.message : /* istanbul ignore next */ String(fetchErr);
          logger.error('Failed to fetch dynamic schedule content', fetchErr instanceof Error ? fetchErr : /* istanbul ignore next */ undefined, { uri, scheduleId });
          await markDraftFailed(uri, `content_url_fetch_failed: ${errMsg}`, false);
          await updateScheduleStatus(scheduleId, 'error');
          return;
        }
      } else {
        record = JSON.parse(
          /* istanbul ignore next */ (await getDraftRecord(uri)) ?? '{}',
        ) as Record<string, unknown>;

        // Check for override_payload exception on this occurrence
        if (scheduleId && draftRaw?.scheduled_at) {
          const schedule = await getRawSchedule(scheduleId);
          if (schedule) {
            try {
              const parsedRule = JSON.parse(schedule.recurrence_rule) as RecurrenceRule;
              const overrideRecord = getOccurrenceRecord(parsedRule, new Date(Number(draftRaw.scheduled_at)));
              if (overrideRecord) record = overrideRecord;
            } catch {
              // Invalid rule JSON — use draft record as-is
            }
          }
        }
      }

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

    // Handle schedule chaining (create next draft for recurring schedules)
    const rawRow = await getDraftRawRow(uri);
    if (rawRow?.schedule_id) {
      try {
        await handleScheduleChaining(rawRow);
      } catch (chainErr) {
        logger.error('Error in schedule chaining (non-fatal)', chainErr instanceof Error ? chainErr : /* istanbul ignore next */ undefined, { uri });
      }
    }

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
    const errCode = (err as { error?: string }).error ?? '';
    logger.error('Failed to publish draft', err instanceof Error ? err : /* istanbul ignore next */ undefined, { uri });

    // Permanent auth failures — re-authentication required, retrying won't help
    if (errCode === 'invalid_token' || errMsg.includes('invalid_grant') || errMsg.includes('revoked')) {
      await markDraftFailed(uri, `oauth_failure: ${errMsg}`, false);
      schedulerPublishesTotal.inc({ result: 'failed' });
      logger.warn('Draft failed due to OAuth auth error, marked as permanently failed', { uri });
      return;
    }

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
