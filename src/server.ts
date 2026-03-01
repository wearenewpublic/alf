// ABOUTME: Express + XRPC server with write proxying (draft creation) and draft management endpoints

import express from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { readFileSync } from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { LexiconDoc } from '@atproto/lexicon';
import * as xrpc from '@atproto/xrpc-server';
import { schemas as atprotoSchemas } from '@atproto/api';
import { TID } from '@atproto/common';
import { cidForRecord } from '@atproto/repo';
import type { ServiceConfig } from './config.js';
import { createLogger, rootLogger } from './logger.js';
import { verifyRequestAuth, extractPdsUrlFromToken, extractBearerToken, verifyDpopBoundToken } from './auth.js';
import { httpRequestsTotal, httpRequestDuration } from './metrics.js';
import { extractDidFromAtUri } from './schema.js';
import { createOAuthRouter } from './routes/oauth.js';
import {
  createDraft,
  getDraft,
  getDraftRawRow,
  getDraftByTriggerKeyHash,
  listDrafts,
  scheduleDraft,
  updateDraft,
  cancelDraft,
  storeDraftBlob,
  getUserAuthorization,
  countActiveDraftsForUser,
  deleteUserData,
  createSchedule,
  getSchedule,
  getRawSchedule,
  listSchedules,
  updateSchedule,
  updateScheduleNextDraft,
  deleteSchedule,
} from './storage.js';
import { publishDraft, notifyScheduler } from './scheduler.js';
import { encrypt, decrypt, hmac } from './encrypt.js';
import { computeNextOccurrence } from '@newpublic/recurrence';
import type { RecurrenceRule } from '@newpublic/recurrence';

const RAW_CODEC = 0x55;

/**
 * Compute a blob CID using ATProto's algorithm: CIDv1, raw codec (0x55), SHA-256 multihash.
 * Returns base32-encoded string (bafkrei... prefix).
 */
async function computeBlobCid(data: Uint8Array): Promise<string> {
  const hash = await sha256.digest(data);
  const cid = CID.createV1(RAW_CODEC, hash);
  return cid.toString();
}

/**
 * Create a 'once' schedule and its first (only) draft, routing the draft through schedule machinery.
 * Used by createRecord/putRecord when x-scheduled-at header is present.
 */
async function createOnceDraftThroughSchedule(params: {
  userDid: string;
  collection: string;
  rkey: string;
  uri: string;
  cid: string;
  record: Record<string, unknown>;
  scheduledAt: number;
  action: 'create' | 'put';
  triggerKeyHash?: string;
  triggerKeyEncrypted?: string;
}): Promise<void> {
  const scheduleId = randomUUID();
  const onceRule: RecurrenceRule = {
    rule: { type: 'once', datetime: new Date(params.scheduledAt).toISOString() },
  };
  await createSchedule({
    id: scheduleId,
    userDid: params.userDid,
    collection: params.collection,
    record: params.record,
    contentUrl: null,
    recurrenceRule: onceRule as unknown as Record<string, unknown>,
    timezone: 'UTC',
  });
  await createDraft({
    uri: params.uri,
    userDid: params.userDid,
    collection: params.collection,
    rkey: params.rkey,
    record: params.record,
    recordCid: params.cid,
    action: params.action,
    scheduledAt: params.scheduledAt,
    scheduleId,
    triggerKeyHash: params.triggerKeyHash,
    triggerKeyEncrypted: params.triggerKeyEncrypted,
  });
  await updateScheduleNextDraft(scheduleId, params.uri);
}

const logger = createLogger('Server');

function loadLexicons(): LexiconDoc[] {
  // Load town.roundabout.scheduledPosts lexicons from bundled JSON files
  const lexiconDir = path.join(__dirname, '..', 'lexicons', 'town', 'roundabout', 'scheduledPosts');
  const bundledNames = [
    'defs',
    'listPosts', 'getPost', 'schedulePost', 'publishPost', 'updatePost', 'deletePost',
    'createSchedule', 'listSchedules', 'getSchedule', 'updateSchedule', 'deleteSchedule',
  ];
  const bundled = bundledNames.map(name =>
    JSON.parse(readFileSync(path.join(lexiconDir, `${name}.json`), 'utf8')) as LexiconDoc,
  );

  // Load standard ATProto write lexicons from @atproto/api
  const atprotoIds = [
    'com.atproto.repo.createRecord',
    'com.atproto.repo.putRecord',
    'com.atproto.repo.deleteRecord',
  ];
  const atproto = atprotoIds.map(id => {
    const schema = atprotoSchemas.find(s => s.id === id);
    /* istanbul ignore next */
    if (!schema) throw new Error(`Required lexicon not found: ${id}`);
    return schema;
  });

  return [...bundled, ...atproto];
}

/**
 * Compute an AT-URI from the user DID, collection, and rkey
 */
function buildAtUri(did: string, collection: string, rkey: string): string {
  return `at://${did}/${collection}/${rkey}`;
}

/**
 * Extract PDS URL from a Bearer token, falling back to a PLC-resolved URL.
 * For simplicity in dev, use the config's plcRoot to derive a default PDS URL.
 */
function getPdsUrlFromToken(token: string, defaultPdsUrl: string): string {
  return extractPdsUrlFromToken(token, defaultPdsUrl);
}

/**
 * Build the one-time trigger URL from a plaintext key.
 */
function buildTriggerUrl(serviceUrl: string, plainKey: string): string {
  return `${serviceUrl}/triggers/${plainKey}`;
}

export function createServer(config: ServiceConfig): express.Application {
  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use(cors({ origin: true }));

  // Structured HTTP request logging (skip health checks to reduce noise)
  app.use(pinoHttp({
    logger: rootLogger,
    autoLogging: {
      ignore: (req) => req.url === '/health' || req.url === '/xrpc/_health',
    },
  }));

  // HTTP metrics middleware
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const endpoint = (req.route as { path?: string } | undefined)?.path ?? req.path ?? /* istanbul ignore next */ 'unknown';
      const duration = (Date.now() - start) / 1000;
      httpRequestsTotal.inc({ method: req.method, endpoint, status_code: String(res.statusCode) });
      httpRequestDuration.observe({ method: req.method, endpoint }, duration);
    });
    next();
  });

  // Health check
  app.get('/xrpc/_health', (_req, res) => {
    res.json({ version: '1.0.0', service: 'alf' });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'alf' });
  });

  // OAuth routes
  app.use('/oauth', createOAuthRouter(config));

  // -------------------------------------------------------------------------
  // Blob upload endpoint — stores raw image bytes for deferred upload at publish time
  // POST /blob
  // Auth: Bearer token
  // Body: raw image bytes
  // Content-Type: image/jpeg | image/png | etc.
  // Returns: { cid, mimeType, size }
  // -------------------------------------------------------------------------
  app.post('/blob', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
    let user: { did: string };
    try {
      user = await requireAuthFromRequest(req.headers.authorization, req.headers.dpop as string | undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : /* istanbul ignore next */ String(err);
      res.status(401).json({ error: 'AuthRequired', message: msg });
      return;
    }
    try {
      const data = req.body as Buffer;
      if (!data || data.length === 0) {
        res.status(400).json({ error: 'InvalidRequest', message: 'Request body is required' });
        return;
      }
      const mimeType = (req.headers['content-type'] || /* istanbul ignore next */ 'application/octet-stream').split(';')[0]?.trim() || /* istanbul ignore next */ 'application/octet-stream';
      const cid = await computeBlobCid(data);
      await storeDraftBlob(user.did, cid, data, mimeType, data.length);
      logger.info('Blob stored', { did: user.did, cid, size: data.length });
      res.json({ cid, mimeType, size: data.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : /* istanbul ignore next */ String(err);
      logger.error('Blob upload failed', err instanceof Error ? err : /* istanbul ignore next */ undefined);
      res.status(500).json({ error: 'InternalError', message: msg });
    }
  });

  // -------------------------------------------------------------------------
  // OAuth status endpoint — returns whether the requesting user has an authorization
  // GET /oauth/status
  // Auth: Bearer token
  // Returns: { authorized: boolean, authType: string | null }
  // -------------------------------------------------------------------------
  app.get('/oauth/status', async (req, res) => {
    try {
      const user = await requireAuthFromRequest(req.headers.authorization, req.headers.dpop as string | undefined);
      const auth = await getUserAuthorization(user.did);
      res.json({
        authorized: !!auth,
        authType: auth?.auth_type ?? null,
      });
    } catch (err) {
      logger.warn('oauth/status auth failed', { error: err instanceof Error ? err.message : /* istanbul ignore next */ String(err) });
      res.json({ authorized: false, authType: null });
    }
  });

  // DELETE /account — cancel all drafts and remove authorization for the authenticated user
  app.delete('/account', async (req, res) => {
    try {
      const user = await requireAuthFromRequest(req.headers.authorization, req.headers.dpop as string | undefined);
      await deleteUserData(user.did);
      res.status(200).json({ deleted: true });
    } catch (err) {
      logger.warn('delete account failed', { error: err instanceof Error ? err.message : /* istanbul ignore next */ String(err) });
      res.status(401).json({ error: 'Unauthorized' });
    }
  });

  // -------------------------------------------------------------------------
  // Webhook trigger endpoint — no auth required (the URL is the secret)
  // POST /triggers/:key
  // Returns: { published: true, uri: "at://..." } or error
  // -------------------------------------------------------------------------
  app.post('/triggers/:key', async (req, res) => {
    const plainKey = req.params.key;
    /* istanbul ignore next */
    if (!plainKey) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Trigger key is required' });
      return;
    }

    try {
      // Compute HMAC of the incoming key to look up the draft
      const keyHash = hmac(plainKey, config.encryptionKey);
      const draftRow = await getDraftByTriggerKeyHash(keyHash);

      if (!draftRow) {
        res.status(404).json({ error: 'NotFound', message: 'Trigger key not found' });
        return;
      }

      // Check if already in terminal state
      const terminalStatuses = ['published', 'failed', 'cancelled'];
      if (terminalStatuses.includes(draftRow.status)) {
        res.status(409).json({ error: 'TriggerAlreadyFired', message: 'This trigger has already been used or the draft is no longer active' });
        return;
      }

      // Publish the draft (same path as publishPost)
      await publishDraft(draftRow.uri, config);
      notifyScheduler();

      const published = await getDraft(draftRow.uri);
      const actualStatus = published?.status ?? /* istanbul ignore next */ 'unknown';
      if (actualStatus === 'published') {
        res.json({ published: true, uri: draftRow.uri });
      } else {
        res.status(500).json({
          error: 'PublishFailed',
          message: published?.failureReason ?? 'Draft failed to publish',
          status: actualStatus,
          uri: draftRow.uri,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : /* istanbul ignore next */ String(err);
      logger.error('Trigger endpoint error', err instanceof Error ? err : /* istanbul ignore next */ undefined);
      res.status(500).json({ error: 'InternalError', message: msg });
    }
  });

  // Load lexicons
  const lexicons = loadLexicons();
  logger.info(`Loaded ${lexicons.length} lexicons`);

  // Create XRPC server
  const server = xrpc.createServer(lexicons, {
    payload: {
      jsonLimit: 1024 * 1024, // 1MB
      textLimit: 100 * 1024,
      blobLimit: 5 * 1024 * 1024,
    },
  });

  // Default PDS URL for resolving user PDS (used as fallback for legacy tokens)
  const defaultPdsUrl = 'http://localhost:2583';

  // Auth helper for raw Express handlers (throws plain Error)
  async function requireAuthFromRequest(
    authHeader: string | undefined,
    dpopHeader?: string,
  ): Promise<{ did: string }> {
    const scheme = authHeader?.split(' ')[0];
    if (scheme === 'DPoP' && dpopHeader) {
      const token = extractBearerToken(authHeader);
      return await verifyDpopBoundToken(token, dpopHeader);
    }
    const token = extractBearerToken(authHeader);
    const pdsUrl = getPdsUrlFromToken(token, defaultPdsUrl);
    return await verifyRequestAuth(authHeader, pdsUrl);
  }

  // Auth helper: extracts and verifies the Bearer token, throws AuthRequiredError on failure
  async function requireAuth(authHeader: string | undefined, dpopHeader?: string): Promise<{ did: string }> {
    try {
      return await requireAuthFromRequest(authHeader, dpopHeader);
    } catch (err) {
      /* istanbul ignore next */
      const msg = err instanceof Error ? err.message : String(err);
      throw new xrpc.AuthRequiredError(msg);
    }
  }

  // URI helper: extracts DID from an AT-URI, throws InvalidRequestError on invalid format
  function parseDid(uri: string): string {
    try {
      return extractDidFromAtUri(uri);
    } catch {
      /* istanbul ignore next */
      throw new xrpc.InvalidRequestError('Invalid uri format');
    }
  }

  // -------------------------------------------------------------------------
  // Write Interface - all three endpoints always create drafts
  // Supports x-trigger: webhook header to create a one-time trigger URL
  // -------------------------------------------------------------------------

  server.method('com.atproto.repo.createRecord', async (ctx: xrpc.HandlerContext) => {
    const user = await requireAuth(ctx.req.headers.authorization, ctx.req.headers.dpop as string | undefined);

    const body = ctx.input?.body as {
      repo: string;
      collection: string;
      rkey?: string;
      record: Record<string, unknown>;
    };

    /* istanbul ignore next */
    if (!body?.collection || !body?.record) {
      throw new xrpc.InvalidRequestError('collection and record are required');
    }

    if (body.repo && body.repo !== user.did) {
      throw new xrpc.InvalidRequestError('repo must match authenticated user');
    }

    if (config.maxDraftsPerUser !== null) {
      const activeCount = await countActiveDraftsForUser(user.did);
      if (activeCount >= config.maxDraftsPerUser) {
        throw new xrpc.InvalidRequestError(
          `Draft limit reached: you may have at most ${config.maxDraftsPerUser} active drafts`,
          'DraftLimitExceeded',
        );
      }
    }

    const rkey = body.rkey ?? TID.nextStr();
    const uri = buildAtUri(user.did, body.collection, rkey);

    // Compute CID deterministically
    const cid = (await cidForRecord(body.record)).toString();

    // Check for scheduling header
    const scheduledAtHeader = ctx.req.headers['x-scheduled-at'] as string | undefined;
    const scheduledAt = scheduledAtHeader ? new Date(scheduledAtHeader).getTime() : undefined;

    // Check for webhook trigger header
    const triggerHeader = ctx.req.headers['x-trigger'] as string | undefined;
    let triggerKeyHash: string | undefined;
    let triggerKeyEncrypted: string | undefined;
    let triggerUrl: string | undefined;

    if (triggerHeader === 'webhook') {
      const plainKey = randomUUID();
      triggerKeyHash = hmac(plainKey, config.encryptionKey);
      triggerKeyEncrypted = encrypt(plainKey, config.encryptionKey);
      triggerUrl = buildTriggerUrl(config.serviceUrl, plainKey);
    }

    try {
      if (scheduledAt) {
        await createOnceDraftThroughSchedule({
          userDid: user.did,
          collection: body.collection,
          rkey,
          uri,
          cid,
          record: body.record,
          scheduledAt,
          action: 'create',
          triggerKeyHash,
          triggerKeyEncrypted,
        });
      } else {
        await createDraft({
          uri,
          userDid: user.did,
          collection: body.collection,
          rkey,
          record: body.record,
          recordCid: cid,
          action: 'create',
          scheduledAt: undefined,
          triggerKeyHash,
          triggerKeyEncrypted,
        });
      }
    } catch (err) {
      if ((err as { code?: string }).code === 'DuplicateDraft') {
        throw new xrpc.InvalidRequestError((err as Error).message, 'DuplicateDraft');
      }
      throw err;
    }

    if (scheduledAt) notifyScheduler();
    logger.info('createRecord draft created', { uri, collection: body.collection });

    return {
      encoding: 'application/json',
      body: {
        uri,
        cid,
        validationStatus: 'unknown',
        ...(triggerUrl ? { triggerUrl } : {}),
      },
    };
  });

  server.method('com.atproto.repo.putRecord', async (ctx: xrpc.HandlerContext) => {
    const user = await requireAuth(ctx.req.headers.authorization, ctx.req.headers.dpop as string | undefined);

    const body = ctx.input?.body as {
      repo: string;
      collection: string;
      rkey: string;
      record: Record<string, unknown>;
    };

    /* istanbul ignore next */
    if (!body?.collection || !body?.rkey || !body?.record) {
      throw new xrpc.InvalidRequestError('collection, rkey, and record are required');
    }

    if (body.repo && body.repo !== user.did) {
      throw new xrpc.InvalidRequestError('repo must match authenticated user');
    }

    if (config.maxDraftsPerUser !== null) {
      const activeCount = await countActiveDraftsForUser(user.did);
      if (activeCount >= config.maxDraftsPerUser) {
        throw new xrpc.InvalidRequestError(
          `Draft limit reached: you may have at most ${config.maxDraftsPerUser} active drafts`,
          'DraftLimitExceeded',
        );
      }
    }

    const uri = buildAtUri(user.did, body.collection, body.rkey);
    const cid = (await cidForRecord(body.record)).toString();

    const scheduledAtHeader = ctx.req.headers['x-scheduled-at'] as string | undefined;
    const scheduledAt = scheduledAtHeader ? new Date(scheduledAtHeader).getTime() : undefined;

    const triggerHeader = ctx.req.headers['x-trigger'] as string | undefined;
    let triggerKeyHash: string | undefined;
    let triggerKeyEncrypted: string | undefined;
    let triggerUrl: string | undefined;

    if (triggerHeader === 'webhook') {
      const plainKey = randomUUID();
      triggerKeyHash = hmac(plainKey, config.encryptionKey);
      triggerKeyEncrypted = encrypt(plainKey, config.encryptionKey);
      triggerUrl = buildTriggerUrl(config.serviceUrl, plainKey);
    }

    try {
      if (scheduledAt) {
        await createOnceDraftThroughSchedule({
          userDid: user.did,
          collection: body.collection,
          rkey: body.rkey,
          uri,
          cid,
          record: body.record,
          scheduledAt,
          action: 'put',
          triggerKeyHash,
          triggerKeyEncrypted,
        });
      } else {
        await createDraft({
          uri,
          userDid: user.did,
          collection: body.collection,
          rkey: body.rkey,
          record: body.record,
          recordCid: cid,
          action: 'put',
          scheduledAt: undefined,
          triggerKeyHash,
          triggerKeyEncrypted,
        });
      }
    } catch (err) {
      if ((err as { code?: string }).code === 'DuplicateDraft') {
        throw new xrpc.InvalidRequestError((err as Error).message, 'DuplicateDraft');
      }
      throw err;
    }

    if (scheduledAt) notifyScheduler();
    logger.info('putRecord draft created', { uri, collection: body.collection });

    return {
      encoding: 'application/json',
      body: {
        uri,
        cid,
        validationStatus: 'unknown',
        ...(triggerUrl ? { triggerUrl } : {}),
      },
    };
  });

  server.method('com.atproto.repo.deleteRecord', async (ctx: xrpc.HandlerContext) => {
    const user = await requireAuth(ctx.req.headers.authorization, ctx.req.headers.dpop as string | undefined);

    const body = ctx.input?.body as {
      repo: string;
      collection: string;
      rkey: string;
    };

    /* istanbul ignore next */
    if (!body?.collection || !body?.rkey) {
      throw new xrpc.InvalidRequestError('collection and rkey are required');
    }

    if (body.repo && body.repo !== user.did) {
      throw new xrpc.InvalidRequestError('repo must match authenticated user');
    }

    if (config.maxDraftsPerUser !== null) {
      const activeCount = await countActiveDraftsForUser(user.did);
      if (activeCount >= config.maxDraftsPerUser) {
        throw new xrpc.InvalidRequestError(
          `Draft limit reached: you may have at most ${config.maxDraftsPerUser} active drafts`,
          'DraftLimitExceeded',
        );
      }
    }

    const uri = buildAtUri(user.did, body.collection, body.rkey);

    const scheduledAtHeader = ctx.req.headers['x-scheduled-at'] as string | undefined;
    const scheduledAt = scheduledAtHeader ? new Date(scheduledAtHeader).getTime() : undefined;

    const triggerHeader = ctx.req.headers['x-trigger'] as string | undefined;
    let triggerKeyHash: string | undefined;
    let triggerKeyEncrypted: string | undefined;
    let triggerUrl: string | undefined;

    if (triggerHeader === 'webhook') {
      const plainKey = randomUUID();
      triggerKeyHash = hmac(plainKey, config.encryptionKey);
      triggerKeyEncrypted = encrypt(plainKey, config.encryptionKey);
      triggerUrl = buildTriggerUrl(config.serviceUrl, plainKey);
    }

    try {
      await createDraft({
        uri,
        userDid: user.did,
        collection: body.collection,
        rkey: body.rkey,
        record: null,
        recordCid: null,
        action: 'delete',
        scheduledAt,
        triggerKeyHash,
        triggerKeyEncrypted,
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'DuplicateDraft') {
        throw new xrpc.InvalidRequestError((err as Error).message, 'DuplicateDraft');
      }
      throw err;
    }

    if (scheduledAt) notifyScheduler();
    logger.info('deleteRecord draft created', { uri, collection: body.collection });

    return {
      encoding: 'application/json',
      body: {
        ...(triggerUrl ? { triggerUrl } : {}),
      },
    };
  });

  // -------------------------------------------------------------------------
  // Draft Management Endpoints
  // -------------------------------------------------------------------------

  server.method('town.roundabout.scheduledPosts.listPosts', async (ctx: xrpc.HandlerContext) => {
    const user = await requireAuth(ctx.req.headers.authorization, ctx.req.headers.dpop as string | undefined);

    const params = ctx.params as {
      repo: string;
      status?: string;
      limit?: number;
      cursor?: string;
    };

    // Users can only list their own drafts
    if (params.repo !== user.did) {
      throw new xrpc.AuthRequiredError('You can only list your own drafts');
    }

    const result = await listDrafts({
      userDid: user.did,
      status: params.status,
      limit: Number(params.limit ?? /* istanbul ignore next */ 50),
      cursor: params.cursor,
    });

    // Decrypt trigger keys so clients can retrieve the webhook URL from the list
    const posts = result.drafts.map(({ triggerKeyEncrypted, ...view }) => {
      if (triggerKeyEncrypted) {
        try {
          const plainKey = decrypt(triggerKeyEncrypted, config.encryptionKey);
          return { ...view, triggerUrl: buildTriggerUrl(config.serviceUrl, plainKey) };
        } catch {
          // Decryption failure — omit triggerUrl for this draft
        }
      }
      return view;
    });

    return {
      encoding: 'application/json',
      body: {
        posts,
        cursor: result.cursor,
      },
    };
  });

  server.method('town.roundabout.scheduledPosts.getPost', async (ctx: xrpc.HandlerContext) => {
    const user = await requireAuth(ctx.req.headers.authorization, ctx.req.headers.dpop as string | undefined);

    const params = ctx.params as { uri: string };
    /* istanbul ignore next */
    if (!params.uri) {
      throw new xrpc.InvalidRequestError('uri is required');
    }

    const draft = await getDraft(params.uri);
    if (!draft) {
      throw new xrpc.InvalidRequestError('Draft not found', 'NotFound');
    }

    // Verify the draft belongs to the requesting user
    const draftDid = parseDid(params.uri);
    if (draftDid !== user.did) {
      throw new xrpc.AuthRequiredError('You can only view your own drafts');
    }

    // Populate triggerUrl if the draft has a webhook trigger
    const rawRow = await getDraftRawRow(params.uri);
    let triggerUrl: string | undefined;
    if (rawRow?.trigger_key_encrypted) {
      try {
        const plainKey = decrypt(rawRow.trigger_key_encrypted, config.encryptionKey);
        triggerUrl = buildTriggerUrl(config.serviceUrl, plainKey);
      } catch {
        // Decryption failure — don't expose the URL, just omit it
        logger.warn('Failed to decrypt trigger key for getPost', { uri: params.uri });
      }
    }

    return {
      encoding: 'application/json',
      body: {
        ...draft,
        ...(triggerUrl ? { triggerUrl } : {}),
      },
    };
  });

  server.method('town.roundabout.scheduledPosts.schedulePost', async (ctx: xrpc.HandlerContext) => {
    const user = await requireAuth(ctx.req.headers.authorization, ctx.req.headers.dpop as string | undefined);

    const body = ctx.input?.body as { uri: string; publishAt: string };
    /* istanbul ignore next */
    if (!body?.uri || !body?.publishAt) {
      throw new xrpc.InvalidRequestError('uri and publishAt are required');
    }

    // Verify ownership
    const draftDid = parseDid(body.uri);
    if (draftDid !== user.did) {
      throw new xrpc.AuthRequiredError('You can only schedule your own drafts');
    }

    const publishAt = new Date(body.publishAt).getTime();
    /* istanbul ignore next */
    if (isNaN(publishAt)) {
      throw new xrpc.InvalidRequestError('publishAt must be a valid ISO 8601 datetime');
    }

    const draft = await scheduleDraft(body.uri, publishAt);
    if (!draft) {
      throw new xrpc.InvalidRequestError('Draft not found or not in a schedulable state', 'NotFound');
    }

    notifyScheduler();

    return {
      encoding: 'application/json',
      body: draft,
    };
  });

  server.method('town.roundabout.scheduledPosts.publishPost', async (ctx: xrpc.HandlerContext) => {
    const user = await requireAuth(ctx.req.headers.authorization, ctx.req.headers.dpop as string | undefined);

    const body = ctx.input?.body as { uri: string };
    /* istanbul ignore next */
    if (!body?.uri) {
      throw new xrpc.InvalidRequestError('uri is required');
    }

    const draftDid = parseDid(body.uri);
    if (draftDid !== user.did) {
      throw new xrpc.AuthRequiredError('You can only publish your own drafts');
    }

    const draftBefore = await getDraft(body.uri);
    if (!draftBefore) {
      throw new xrpc.InvalidRequestError('Draft not found', 'NotFound');
    }

    // Publish synchronously
    await publishDraft(body.uri, config);
    notifyScheduler();

    const draft = await getDraft(body.uri);
    if (!draft) {
      throw new xrpc.InvalidRequestError('Draft not found after publish', 'NotFound');
    }

    return {
      encoding: 'application/json',
      body: draft,
    };
  });

  server.method('town.roundabout.scheduledPosts.updatePost', async (ctx: xrpc.HandlerContext) => {
    const user = await requireAuth(ctx.req.headers.authorization, ctx.req.headers.dpop as string | undefined);

    const body = ctx.input?.body as {
      uri: string;
      record?: Record<string, unknown>;
      scheduledAt?: string;
    };
    /* istanbul ignore next */
    if (!body?.uri) {
      throw new xrpc.InvalidRequestError('uri is required');
    }

    const draftDid = parseDid(body.uri);
    if (draftDid !== user.did) {
      throw new xrpc.AuthRequiredError('You can only update your own drafts');
    }

    const updateParams: {
      record?: Record<string, unknown>;
      recordCid?: string;
      scheduledAt?: number;
    } = {};

    if (body.record !== undefined) {
      updateParams.record = body.record;
      updateParams.recordCid = (await cidForRecord(body.record)).toString();
    }

    if (body.scheduledAt !== undefined) {
      const scheduledAt = new Date(body.scheduledAt).getTime();
      /* istanbul ignore next */
      if (isNaN(scheduledAt)) {
        throw new xrpc.InvalidRequestError('scheduledAt must be a valid ISO 8601 datetime');
      }
      updateParams.scheduledAt = scheduledAt;
    }

    const draft = await updateDraft(body.uri, updateParams);
    if (!draft) {
      throw new xrpc.InvalidRequestError('Draft not found or not in an updatable state', 'NotFound');
    }

    notifyScheduler();

    return {
      encoding: 'application/json',
      body: draft,
    };
  });

  server.method('town.roundabout.scheduledPosts.deletePost', async (ctx: xrpc.HandlerContext) => {
    const user = await requireAuth(ctx.req.headers.authorization, ctx.req.headers.dpop as string | undefined);

    const body = ctx.input?.body as { uri: string };
    /* istanbul ignore next */
    if (!body?.uri) {
      throw new xrpc.InvalidRequestError('uri is required');
    }

    const draftDid = parseDid(body.uri);
    if (draftDid !== user.did) {
      throw new xrpc.AuthRequiredError('You can only delete your own drafts');
    }

    await cancelDraft(body.uri);
    notifyScheduler();

    return {
      encoding: 'application/json',
      body: {},
    };
  });

  // -------------------------------------------------------------------------
  // Schedule Management Endpoints
  // -------------------------------------------------------------------------

  server.method('town.roundabout.scheduledPosts.createSchedule', async (ctx: xrpc.HandlerContext) => {
    const user = await requireAuth(ctx.req.headers.authorization, ctx.req.headers.dpop as string | undefined);

    const body = ctx.input?.body as {
      collection: string;
      recurrenceRule: Record<string, unknown>;
      timezone: string;
      record?: Record<string, unknown>;
      contentUrl?: string;
    };

    /* istanbul ignore next */
    if (!body?.collection || !body?.recurrenceRule || !body?.timezone) {
      throw new xrpc.InvalidRequestError('collection, recurrenceRule, and timezone are required');
    }

    if (body.record && body.contentUrl) {
      throw new xrpc.InvalidRequestError('record and contentUrl are mutually exclusive');
    }

    // Validate the recurrence rule by computing the first occurrence
    const rule = body.recurrenceRule as unknown as RecurrenceRule;

    const nextFireAt = computeNextOccurrence(rule, new Date());
    if (!nextFireAt) {
      throw new xrpc.InvalidRequestError('Recurrence rule produces no future occurrences');
    }

    const scheduleId = randomUUID();
    await createSchedule({
      id: scheduleId,
      userDid: user.did,
      collection: body.collection,
      record: body.record ?? null,
      contentUrl: body.contentUrl ?? null,
      recurrenceRule: body.recurrenceRule,
      timezone: body.timezone,
    });

    // Create the first draft
    const rkey = `sched-${Date.now()}-${randomUUID().substring(0, 8)}`;
    const uri = buildAtUri(user.did, body.collection, rkey);
    const draftRecord = body.contentUrl ? null : (body.record ?? /* istanbul ignore next */ null);

    await createDraft({
      uri,
      userDid: user.did,
      collection: body.collection,
      rkey,
      record: draftRecord,
      recordCid: null,
      action: 'create',
      scheduledAt: nextFireAt.getTime(),
      scheduleId,
    });

    await updateScheduleNextDraft(scheduleId, uri);
    notifyScheduler();

    const updatedSchedule = await getSchedule(scheduleId);
    logger.info('Schedule created', { scheduleId, nextFireAt: nextFireAt.toISOString() });

    return {
      encoding: 'application/json',
      body: { schedule: updatedSchedule },
    };
  });

  server.method('town.roundabout.scheduledPosts.listSchedules', async (ctx: xrpc.HandlerContext) => {
    const user = await requireAuth(ctx.req.headers.authorization, ctx.req.headers.dpop as string | undefined);

    const params = ctx.params as {
      repo: string;
      status?: string;
      limit?: number;
      cursor?: string;
    };

    if (params.repo !== user.did) {
      throw new xrpc.AuthRequiredError('You can only list your own schedules');
    }

    const result = await listSchedules({
      userDid: user.did,
      status: params.status,
      limit: Number(params.limit ?? /* istanbul ignore next */ 50),
      cursor: params.cursor,
    });

    return {
      encoding: 'application/json',
      body: {
        schedules: result.schedules,
        cursor: result.cursor,
      },
    };
  });

  server.method('town.roundabout.scheduledPosts.getSchedule', async (ctx: xrpc.HandlerContext) => {
    const user = await requireAuth(ctx.req.headers.authorization, ctx.req.headers.dpop as string | undefined);

    const params = ctx.params as { id: string };
    /* istanbul ignore next */
    if (!params.id) {
      throw new xrpc.InvalidRequestError('id is required');
    }

    const schedule = await getSchedule(params.id);
    if (!schedule) {
      throw new xrpc.InvalidRequestError('Schedule not found', 'NotFound');
    }

    // Verify ownership
    const raw = await getRawSchedule(params.id);
    if (raw?.user_did !== user.did) {
      throw new xrpc.AuthRequiredError('You can only view your own schedules');
    }

    return {
      encoding: 'application/json',
      body: { schedule },
    };
  });

  server.method('town.roundabout.scheduledPosts.updateSchedule', async (ctx: xrpc.HandlerContext) => {
    const user = await requireAuth(ctx.req.headers.authorization, ctx.req.headers.dpop as string | undefined);

    const body = ctx.input?.body as {
      id: string;
      recurrenceRule?: Record<string, unknown>;
      timezone?: string;
      record?: Record<string, unknown> | null;
      contentUrl?: string | null;
      status?: 'active' | 'paused';
    };

    /* istanbul ignore next */
    if (!body?.id) {
      throw new xrpc.InvalidRequestError('id is required');
    }

    const raw = await getRawSchedule(body.id);
    if (!raw) {
      throw new xrpc.InvalidRequestError('Schedule not found', 'NotFound');
    }
    if (raw.user_did !== user.did) {
      throw new xrpc.AuthRequiredError('You can only update your own schedules');
    }

    const updateParams: Parameters<typeof updateSchedule>[1] = {};
    if ('record' in body) updateParams.record = body.record ?? /* istanbul ignore next */ null;
    if ('contentUrl' in body) updateParams.contentUrl = body.contentUrl ?? /* istanbul ignore next */ null;
    if (body.recurrenceRule !== undefined) updateParams.recurrenceRule = body.recurrenceRule;
    if (body.timezone !== undefined) updateParams.timezone = body.timezone;

    // Handle pause/resume
    if (body.status === 'paused' && raw.status === 'active') {
      // Cancel the pending draft
      if (raw.next_draft_uri) {
        await cancelDraft(raw.next_draft_uri);
      }
      updateParams.status = 'paused';
      await updateScheduleNextDraft(body.id, null);
    } else if (body.status === 'active' && raw.status === 'paused') {
      // Resume: create a new next draft
      const ruleJson = body.recurrenceRule ?? JSON.parse(raw.recurrence_rule) as Record<string, unknown>;
      const rule = ruleJson as unknown as RecurrenceRule;
      const nextFireAt = computeNextOccurrence(rule, new Date());
      if (nextFireAt) {
        const rkey = `sched-${Date.now()}-${randomUUID().substring(0, 8)}`;
        const collection = raw.collection;
        const uri = buildAtUri(user.did, collection, rkey);
        const draftRecord = raw.content_url ? null : (raw.record ? JSON.parse(raw.record) as Record<string, unknown> : null);

        await createDraft({
          uri,
          userDid: user.did,
          collection,
          rkey,
          record: draftRecord,
          recordCid: null,
          action: 'create',
          scheduledAt: nextFireAt.getTime(),
          scheduleId: body.id,
        });

        await updateScheduleNextDraft(body.id, uri);
        notifyScheduler();
      }
      updateParams.status = 'active';
    } else if (body.status !== undefined) {
      updateParams.status = body.status;
    }

    const schedule = await updateSchedule(body.id, updateParams);

    return {
      encoding: 'application/json',
      body: { schedule },
    };
  });

  server.method('town.roundabout.scheduledPosts.deleteSchedule', async (ctx: xrpc.HandlerContext) => {
    const user = await requireAuth(ctx.req.headers.authorization, ctx.req.headers.dpop as string | undefined);

    const body = ctx.input?.body as { id: string };
    /* istanbul ignore next */
    if (!body?.id) {
      throw new xrpc.InvalidRequestError('id is required');
    }

    const raw = await getRawSchedule(body.id);
    if (!raw) {
      throw new xrpc.InvalidRequestError('Schedule not found', 'NotFound');
    }
    if (raw.user_did !== user.did) {
      throw new xrpc.AuthRequiredError('You can only delete your own schedules');
    }

    await deleteSchedule(body.id);
    notifyScheduler();

    return {
      encoding: 'application/json',
      body: {},
    };
  });

  // Mount XRPC router
  app.use(server.router);

  // Error handler
  /* istanbul ignore next */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const error = err as Error;
    logger.error('Express error handler caught', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'InternalServerError', message: 'Internal Server Error' });
    }
  });

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}
