// ABOUTME: Express + XRPC server with write proxying (draft creation) and draft management endpoints

import express from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { readFileSync } from 'fs';
import path from 'path';
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
  listDrafts,
  scheduleDraft,
  updateDraft,
  cancelDraft,
  storeDraftBlob,
  getUserAuthorization,
  countActiveDraftsForUser,
  deleteUserData,
} from './storage.js';
import { publishDraft, notifyScheduler } from './scheduler.js';

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

const logger = createLogger('Server');

function loadLexicons(): LexiconDoc[] {
  // Load town.roundabout.scheduledPosts lexicons from bundled JSON files
  const lexiconDir = path.join(__dirname, '..', 'lexicons', 'town', 'roundabout', 'scheduledPosts');
  const bundledNames = ['defs', 'listPosts', 'getPost', 'schedulePost', 'publishPost', 'updatePost', 'deletePost'];
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

    try {
      await createDraft({
        uri,
        userDid: user.did,
        collection: body.collection,
        rkey,
        record: body.record,
        recordCid: cid,
        action: 'create',
        scheduledAt,
      });
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

    try {
      await createDraft({
        uri,
        userDid: user.did,
        collection: body.collection,
        rkey: body.rkey,
        record: body.record,
        recordCid: cid,
        action: 'put',
        scheduledAt,
      });
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
      body: {},
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

    return {
      encoding: 'application/json',
      body: {
        posts: result.drafts,
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

    return {
      encoding: 'application/json',
      body: draft,
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
