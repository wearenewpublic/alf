// Integration tests for the ALF Express/XRPC server

import request from 'supertest';
import { createServer } from '../server';
import type { ServiceConfig } from '../config';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../auth', () => ({
  verifyRequestAuth: jest.fn(),
  extractBearerToken: jest.fn(),
  extractPdsUrlFromToken: jest.fn(),
  verifyDpopBoundToken: jest.fn(),
}));

jest.mock('../storage', () => ({
  createDraft: jest.fn(),
  getDraft: jest.fn(),
  listDrafts: jest.fn(),
  scheduleDraft: jest.fn(),
  updateDraft: jest.fn(),
  cancelDraft: jest.fn(),
  storeDraftBlob: jest.fn(),
  getUserAuthorization: jest.fn(),
  deleteUserData: jest.fn(),
  countActiveDraftsForUser: jest.fn(),
}));

jest.mock('../scheduler', () => ({
  publishDraft: jest.fn(),
  notifyScheduler: jest.fn(),
}));

jest.mock('../routes/oauth', () => ({
  createOAuthRouter: jest.fn(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Router } = require('express') as typeof import('express');
    return Router();
  }),
}));

jest.mock('@atproto/repo', () => ({
  cidForRecord: jest.fn().mockResolvedValue({ toString: () => 'bafyreiaiv3tq5ybbyxjufwxhocbdm3qzduv5ekrxofsjxgvsrw4bjwtlbq' }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { verifyRequestAuth, extractBearerToken, extractPdsUrlFromToken, verifyDpopBoundToken } from '../auth';
import { createDraft, getDraft, listDrafts, scheduleDraft, updateDraft, cancelDraft, storeDraftBlob, getUserAuthorization, countActiveDraftsForUser, deleteUserData } from '../storage';
import { publishDraft, notifyScheduler } from '../scheduler';

const mockVerifyRequestAuth = verifyRequestAuth as jest.Mock;
const mockExtractBearerToken = extractBearerToken as jest.Mock;
const mockExtractPdsUrlFromToken = extractPdsUrlFromToken as jest.Mock;
const mockVerifyDpopBoundToken = verifyDpopBoundToken as jest.Mock;
const mockCreateDraft = createDraft as jest.Mock;
const mockGetDraft = getDraft as jest.Mock;
const mockListDrafts = listDrafts as jest.Mock;
const mockScheduleDraft = scheduleDraft as jest.Mock;
const mockUpdateDraft = updateDraft as jest.Mock;
const mockCancelDraft = cancelDraft as jest.Mock;
const mockStoreDraftBlob = storeDraftBlob as jest.Mock;
const mockGetUserAuthorization = getUserAuthorization as jest.Mock;
const mockDeleteUserData = deleteUserData as jest.Mock;
const mockPublishDraft = publishDraft as jest.Mock;
const mockNotifyScheduler = notifyScheduler as jest.Mock;
const mockCountActiveDraftsForUser = countActiveDraftsForUser as jest.Mock;

const config: ServiceConfig = {
  port: 1986,
  serviceUrl: 'http://localhost:1986',
  plcRoot: 'https://plc.directory',
  handleResolverUrl: 'https://api.bsky.app',
  databaseType: 'sqlite',
  databasePath: ':memory:',
  encryptionKey: 'a'.repeat(64),
  maxDraftsPerUser: null,
  allowedCollections: '*',
};

const AUTH_HEADER = 'Bearer test-token';
const USER_DID = 'did:plc:alice';

function mockAuth() {
  mockExtractBearerToken.mockReturnValue('test-token');
  mockExtractPdsUrlFromToken.mockReturnValue('http://localhost:2583');
  mockVerifyRequestAuth.mockResolvedValue({ did: USER_DID });
  mockVerifyDpopBoundToken.mockResolvedValue({ did: USER_DID });
  mockCountActiveDraftsForUser.mockResolvedValue(0);
}

const DRAFT_VIEW = {
  uri: `at://${USER_DID}/app.bsky.feed.post/abc123`,
  collection: 'app.bsky.feed.post',
  rkey: 'abc123',
  action: 'create' as const,
  status: 'draft' as const,
  createdAt: new Date().toISOString(),
  record: { $type: 'app.bsky.feed.post', text: 'hello' },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ALF server', () => {
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createServer(config);
  });

  // ---- Health checks ----

  describe('GET /xrpc/_health', () => {
    it('returns version and service', async () => {
      const res = await request(app).get('/xrpc/_health');
      expect(res.status).toBe(200);
      expect(res.body.version).toBe('1.0.0');
      expect(res.body.service).toBe('alf');
    });
  });

  describe('GET /health', () => {
    it('returns status ok', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  // ---- Blob upload ----

  describe('POST /blob', () => {
    it('stores a blob and returns cid/mimeType/size', async () => {
      mockAuth();
      mockStoreDraftBlob.mockResolvedValue(undefined);
      const data = Buffer.from('fake image data');
      const res = await request(app)
        .post('/blob')
        .set('Authorization', AUTH_HEADER)
        .set('Content-Type', 'image/jpeg')
        .send(data);
      expect(res.status).toBe(200);
      expect(res.body.cid).toBeDefined();
      expect(res.body.mimeType).toBe('image/jpeg');
      expect(res.body.size).toBe(data.length);
    });

    it('returns 400 when body is empty', async () => {
      mockAuth();
      const res = await request(app)
        .post('/blob')
        .set('Authorization', AUTH_HEADER)
        .set('Content-Type', 'image/jpeg')
        .send(Buffer.alloc(0));
      expect(res.status).toBe(400);
    });

    it('returns 401 when auth fails', async () => {
      mockVerifyRequestAuth.mockRejectedValue(new Error('Unauthorized'));
      mockExtractBearerToken.mockReturnValue('bad');
      mockExtractPdsUrlFromToken.mockReturnValue('http://localhost');
      const res = await request(app)
        .post('/blob')
        .set('Authorization', AUTH_HEADER)
        .send(Buffer.from('data'));
      expect(res.status).toBe(401);
    });

    it('authenticates via DPoP scheme', async () => {
      mockExtractBearerToken.mockReturnValue('dpop-token');
      mockVerifyDpopBoundToken.mockResolvedValue({ did: USER_DID });
      mockStoreDraftBlob.mockResolvedValue(undefined);
      const data = Buffer.from('image data');
      const res = await request(app)
        .post('/blob')
        .set('Authorization', 'DPoP dpop-token')
        .set('dpop', 'proof.header.sig')
        .set('Content-Type', 'image/jpeg')
        .send(data);
      expect(res.status).toBe(200);
      expect(mockVerifyDpopBoundToken).toHaveBeenCalledWith('dpop-token', 'proof.header.sig');
    });

    it('returns 500 when storage fails after successful auth', async () => {
      mockAuth();
      mockStoreDraftBlob.mockRejectedValue(new Error('DB constraint error'));
      const res = await request(app)
        .post('/blob')
        .set('Authorization', AUTH_HEADER)
        .set('Content-Type', 'image/jpeg')
        .send(Buffer.from('data'));
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('InternalError');
    });
  });

  // ---- OAuth status ----

  describe('GET /oauth/status', () => {
    it('returns authorized true when auth record exists', async () => {
      mockAuth();
      mockGetUserAuthorization.mockResolvedValue({ auth_type: 'oauth' });
      const res = await request(app)
        .get('/oauth/status')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(200);
      expect(res.body.authorized).toBe(true);
      expect(res.body.authType).toBe('oauth');
    });

    it('returns authorized false when no auth record', async () => {
      mockAuth();
      mockGetUserAuthorization.mockResolvedValue(null);
      const res = await request(app)
        .get('/oauth/status')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(200);
      expect(res.body.authorized).toBe(false);
    });

    it('returns authorized false when auth throws (unauthenticated)', async () => {
      mockVerifyRequestAuth.mockRejectedValue(new Error('bad token'));
      mockExtractBearerToken.mockReturnValue('bad');
      mockExtractPdsUrlFromToken.mockReturnValue('http://localhost');
      const res = await request(app)
        .get('/oauth/status')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(200);
      expect(res.body.authorized).toBe(false);
    });
  });

  // ---- com.atproto.repo.createRecord ----

  describe('com.atproto.repo.createRecord', () => {
    it('creates a draft and returns uri/cid', async () => {
      mockAuth();
      mockCreateDraft.mockResolvedValue(DRAFT_VIEW);
      const res = await request(app)
        .post('/xrpc/com.atproto.repo.createRecord')
        .set('Authorization', AUTH_HEADER)
        .send({ repo: USER_DID, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: 'hi' } });
      expect(res.status).toBe(200);
      expect(res.body.uri).toBeDefined();
      expect(res.body.cid).toBeDefined();
    });

    it('creates a draft with x-scheduled-at header and notifies scheduler', async () => {
      mockAuth();
      mockCreateDraft.mockResolvedValue(DRAFT_VIEW);
      const futureTime = new Date(Date.now() + 60000).toISOString();
      const res = await request(app)
        .post('/xrpc/com.atproto.repo.createRecord')
        .set('Authorization', AUTH_HEADER)
        .set('x-scheduled-at', futureTime)
        .send({ repo: USER_DID, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: 'hi' } });
      expect(res.status).toBe(200);
      expect(mockNotifyScheduler).toHaveBeenCalled();
    });

    it('returns 400 when collection is missing', async () => {
      mockAuth();
      const res = await request(app)
        .post('/xrpc/com.atproto.repo.createRecord')
        .set('Authorization', AUTH_HEADER)
        .send({ repo: USER_DID, record: { text: 'hi' } });
      expect(res.status).toBe(400);
    });

    it('returns 400 when repo does not match authenticated user', async () => {
      mockAuth();
      const res = await request(app)
        .post('/xrpc/com.atproto.repo.createRecord')
        .set('Authorization', AUTH_HEADER)
        .send({ repo: 'did:plc:other', collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: 'hi' } });
      expect(res.status).toBe(400);
    });

    it('returns 400 on DuplicateDraft', async () => {
      mockAuth();
      mockCreateDraft.mockRejectedValue(Object.assign(new Error('Duplicate'), { code: 'DuplicateDraft' }));
      const res = await request(app)
        .post('/xrpc/com.atproto.repo.createRecord')
        .set('Authorization', AUTH_HEADER)
        .send({ repo: USER_DID, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: 'hi' } });
      expect(res.status).toBe(400);
    });

    it('returns 400 when auth is missing', async () => {
      const res = await request(app)
        .post('/xrpc/com.atproto.repo.createRecord')
        .send({ repo: USER_DID, collection: 'app.bsky.feed.post', record: { text: 'hi' } });
      expect(res.status).toBe(400);
    });

    it('returns 401 when auth throws a non-Error value', async () => {
      mockExtractBearerToken.mockImplementation(() => { throw 'string error'; });
      mockExtractPdsUrlFromToken.mockReturnValue('http://localhost');
      const res = await request(app)
        .post('/xrpc/com.atproto.repo.createRecord')
        .set('Authorization', AUTH_HEADER)
        .send({ repo: USER_DID, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: 'hi' } });
      expect(res.status).toBe(401);
    });

    it('returns 500 when createDraft throws an unexpected error', async () => {
      mockAuth();
      mockCreateDraft.mockRejectedValue(new Error('Unexpected DB error'));
      const res = await request(app)
        .post('/xrpc/com.atproto.repo.createRecord')
        .set('Authorization', AUTH_HEADER)
        .send({ repo: USER_DID, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: 'hi' } });
      expect(res.status).toBe(500);
    });

    it('returns 400 with DraftLimitExceeded when maxDraftsPerUser is reached', async () => {
      mockAuth();
      mockCountActiveDraftsForUser.mockResolvedValue(3);
      const limitedConfig: ServiceConfig = { ...config, maxDraftsPerUser: 3 };
      const limitedApp = createServer(limitedConfig);
      const res = await request(limitedApp)
        .post('/xrpc/com.atproto.repo.createRecord')
        .set('Authorization', AUTH_HEADER)
        .send({ repo: USER_DID, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: 'hi' } });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('DraftLimitExceeded');
    });

    it('allows createRecord when maxDraftsPerUser is null (unlimited)', async () => {
      mockAuth();
      mockCountActiveDraftsForUser.mockResolvedValue(9999);
      mockCreateDraft.mockResolvedValue(DRAFT_VIEW);
      const unlimitedConfig: ServiceConfig = { ...config, maxDraftsPerUser: null };
      const unlimitedApp = createServer(unlimitedConfig);
      const res = await request(unlimitedApp)
        .post('/xrpc/com.atproto.repo.createRecord')
        .set('Authorization', AUTH_HEADER)
        .send({ repo: USER_DID, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: 'hi' } });
      expect(res.status).toBe(200);
      expect(mockCountActiveDraftsForUser).not.toHaveBeenCalled();
    });
  });

  // ---- com.atproto.repo.putRecord ----

  describe('com.atproto.repo.putRecord', () => {
    it('creates a put draft', async () => {
      mockAuth();
      mockCreateDraft.mockResolvedValue({ ...DRAFT_VIEW, action: 'put' });
      const res = await request(app)
        .post('/xrpc/com.atproto.repo.putRecord')
        .set('Authorization', AUTH_HEADER)
        .send({ repo: USER_DID, collection: 'app.bsky.feed.post', rkey: 'abc123', record: { $type: 'app.bsky.feed.post', text: 'update' } });
      expect(res.status).toBe(200);
      expect(res.body.uri).toBeDefined();
    });

    it('returns 400 when rkey is missing', async () => {
      mockAuth();
      const res = await request(app)
        .post('/xrpc/com.atproto.repo.putRecord')
        .set('Authorization', AUTH_HEADER)
        .send({ repo: USER_DID, collection: 'app.bsky.feed.post', record: { text: 'hi' } });
      expect(res.status).toBe(400);
    });

    it('returns 400 when repo mismatches', async () => {
      mockAuth();
      const res = await request(app)
        .post('/xrpc/com.atproto.repo.putRecord')
        .set('Authorization', AUTH_HEADER)
        .send({ repo: 'did:plc:other', collection: 'app.bsky.feed.post', rkey: 'abc', record: { text: 'hi' } });
      expect(res.status).toBe(400);
    });

    it('returns 400 on DuplicateDraft', async () => {
      mockAuth();
      mockCreateDraft.mockRejectedValue(Object.assign(new Error('Dup'), { code: 'DuplicateDraft' }));
      const res = await request(app)
        .post('/xrpc/com.atproto.repo.putRecord')
        .set('Authorization', AUTH_HEADER)
        .send({ repo: USER_DID, collection: 'app.bsky.feed.post', rkey: 'abc', record: { text: 'hi' } });
      expect(res.status).toBe(400);
    });

    it('calls notifyScheduler when x-scheduled-at is set', async () => {
      mockAuth();
      mockCreateDraft.mockResolvedValue(DRAFT_VIEW);
      const res = await request(app)
        .post('/xrpc/com.atproto.repo.putRecord')
        .set('Authorization', AUTH_HEADER)
        .set('x-scheduled-at', new Date(Date.now() + 60000).toISOString())
        .send({ repo: USER_DID, collection: 'app.bsky.feed.post', rkey: 'abc', record: { text: 'hi' } });
      expect(res.status).toBe(200);
      expect(mockNotifyScheduler).toHaveBeenCalled();
    });

    it('returns 500 when createDraft throws an unexpected error', async () => {
      mockAuth();
      mockCreateDraft.mockRejectedValue(new Error('Unexpected DB error'));
      const res = await request(app)
        .post('/xrpc/com.atproto.repo.putRecord')
        .set('Authorization', AUTH_HEADER)
        .send({ repo: USER_DID, collection: 'app.bsky.feed.post', rkey: 'abc', record: { $type: 'app.bsky.feed.post', text: 'hi' } });
      expect(res.status).toBe(500);
    });

    it('returns 400 with DraftLimitExceeded when maxDraftsPerUser is reached', async () => {
      mockAuth();
      mockCountActiveDraftsForUser.mockResolvedValue(3);
      const limitedConfig: ServiceConfig = { ...config, maxDraftsPerUser: 3 };
      const limitedApp = createServer(limitedConfig);
      const res = await request(limitedApp)
        .post('/xrpc/com.atproto.repo.putRecord')
        .set('Authorization', AUTH_HEADER)
        .send({ repo: USER_DID, collection: 'app.bsky.feed.post', rkey: 'abc', record: { $type: 'app.bsky.feed.post', text: 'hi' } });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('DraftLimitExceeded');
    });
  });

  // ---- com.atproto.repo.deleteRecord ----

  describe('com.atproto.repo.deleteRecord', () => {
    it('creates a delete draft', async () => {
      mockAuth();
      mockCreateDraft.mockResolvedValue({ ...DRAFT_VIEW, action: 'delete' });
      const res = await request(app)
        .post('/xrpc/com.atproto.repo.deleteRecord')
        .set('Authorization', AUTH_HEADER)
        .send({ repo: USER_DID, collection: 'app.bsky.feed.post', rkey: 'abc123' });
      expect(res.status).toBe(200);
    });

    it('returns 400 when rkey is missing', async () => {
      mockAuth();
      const res = await request(app)
        .post('/xrpc/com.atproto.repo.deleteRecord')
        .set('Authorization', AUTH_HEADER)
        .send({ repo: USER_DID, collection: 'app.bsky.feed.post' });
      expect(res.status).toBe(400);
    });

    it('returns 400 when repo mismatches', async () => {
      mockAuth();
      const res = await request(app)
        .post('/xrpc/com.atproto.repo.deleteRecord')
        .set('Authorization', AUTH_HEADER)
        .send({ repo: 'did:plc:other', collection: 'app.bsky.feed.post', rkey: 'abc' });
      expect(res.status).toBe(400);
    });

    it('returns 400 on DuplicateDraft', async () => {
      mockAuth();
      mockCreateDraft.mockRejectedValue(Object.assign(new Error('Dup'), { code: 'DuplicateDraft' }));
      const res = await request(app)
        .post('/xrpc/com.atproto.repo.deleteRecord')
        .set('Authorization', AUTH_HEADER)
        .send({ repo: USER_DID, collection: 'app.bsky.feed.post', rkey: 'abc' });
      expect(res.status).toBe(400);
    });

    it('calls notifyScheduler when x-scheduled-at is set', async () => {
      mockAuth();
      mockCreateDraft.mockResolvedValue(DRAFT_VIEW);
      const res = await request(app)
        .post('/xrpc/com.atproto.repo.deleteRecord')
        .set('Authorization', AUTH_HEADER)
        .set('x-scheduled-at', new Date(Date.now() + 60000).toISOString())
        .send({ repo: USER_DID, collection: 'app.bsky.feed.post', rkey: 'abc' });
      expect(res.status).toBe(200);
      expect(mockNotifyScheduler).toHaveBeenCalled();
    });

    it('returns 500 when createDraft throws an unexpected error', async () => {
      mockAuth();
      mockCreateDraft.mockRejectedValue(new Error('Unexpected DB error'));
      const res = await request(app)
        .post('/xrpc/com.atproto.repo.deleteRecord')
        .set('Authorization', AUTH_HEADER)
        .send({ repo: USER_DID, collection: 'app.bsky.feed.post', rkey: 'abc' });
      expect(res.status).toBe(500);
    });

    it('returns 400 with DraftLimitExceeded when maxDraftsPerUser is reached', async () => {
      mockAuth();
      mockCountActiveDraftsForUser.mockResolvedValue(3);
      const limitedConfig: ServiceConfig = { ...config, maxDraftsPerUser: 3 };
      const limitedApp = createServer(limitedConfig);
      const res = await request(limitedApp)
        .post('/xrpc/com.atproto.repo.deleteRecord')
        .set('Authorization', AUTH_HEADER)
        .send({ repo: USER_DID, collection: 'app.bsky.feed.post', rkey: 'abc' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('DraftLimitExceeded');
    });
  });

  // ---- town.roundabout.scheduledPosts.listPosts ----

  describe('town.roundabout.scheduledPosts.listPosts', () => {
    it('returns a list of posts', async () => {
      mockAuth();
      mockListDrafts.mockResolvedValue({ drafts: [DRAFT_VIEW], cursor: undefined });
      const res = await request(app)
        .get(`/xrpc/town.roundabout.scheduledPosts.listPosts?repo=${USER_DID}`)
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.posts)).toBe(true);
    });

    it('returns 400 when repo param is missing', async () => {
      mockAuth();
      const res = await request(app)
        .get('/xrpc/town.roundabout.scheduledPosts.listPosts')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(400);
    });

    it('returns 401 when repo does not match authenticated user', async () => {
      mockAuth();
      const res = await request(app)
        .get('/xrpc/town.roundabout.scheduledPosts.listPosts?repo=did:plc:other')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(401);
    });
  });

  // ---- town.roundabout.scheduledPosts.getPost ----

  describe('town.roundabout.scheduledPosts.getPost', () => {
    const uri = encodeURIComponent(`at://${USER_DID}/app.bsky.feed.post/abc123`);

    it('returns the draft', async () => {
      mockAuth();
      mockGetDraft.mockResolvedValue(DRAFT_VIEW);
      const res = await request(app)
        .get(`/xrpc/town.roundabout.scheduledPosts.getPost?uri=${uri}`)
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(200);
      expect(res.body.uri).toBe(DRAFT_VIEW.uri);
    });

    it('returns 400 when uri is missing', async () => {
      mockAuth();
      const res = await request(app)
        .get('/xrpc/town.roundabout.scheduledPosts.getPost')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(400);
    });

    it('returns 400 when draft is not found', async () => {
      mockAuth();
      mockGetDraft.mockResolvedValue(null);
      const res = await request(app)
        .get(`/xrpc/town.roundabout.scheduledPosts.getPost?uri=${uri}`)
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(400);
    });

    it('returns 401 when draft belongs to a different user', async () => {
      mockAuth();
      mockGetDraft.mockResolvedValue({ ...DRAFT_VIEW, uri: 'at://did:plc:other/app.bsky.feed.post/abc' });
      const res = await request(app)
        .get(`/xrpc/town.roundabout.scheduledPosts.getPost?uri=${encodeURIComponent('at://did:plc:other/app.bsky.feed.post/abc')}`)
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(401);
    });
  });

  // ---- town.roundabout.scheduledPosts.schedulePost ----

  describe('town.roundabout.scheduledPosts.schedulePost', () => {
    const uri = `at://${USER_DID}/app.bsky.feed.post/abc123`;
    const publishAt = new Date(Date.now() + 60000).toISOString();

    it('schedules a draft', async () => {
      mockAuth();
      mockScheduleDraft.mockResolvedValue({ ...DRAFT_VIEW, status: 'scheduled' });
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.schedulePost')
        .set('Authorization', AUTH_HEADER)
        .send({ uri, publishAt });
      expect(res.status).toBe(200);
    });

    it('returns 400 when uri is missing', async () => {
      mockAuth();
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.schedulePost')
        .set('Authorization', AUTH_HEADER)
        .send({ publishAt });
      expect(res.status).toBe(400);
    });

    it('returns 400 when publishAt is not a valid date', async () => {
      mockAuth();
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.schedulePost')
        .set('Authorization', AUTH_HEADER)
        .send({ uri, publishAt: 'not-a-date' });
      expect(res.status).toBe(400);
    });

    it('returns 401 when draft belongs to another user', async () => {
      mockAuth();
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.schedulePost')
        .set('Authorization', AUTH_HEADER)
        .send({ uri: 'at://did:plc:other/app.bsky.feed.post/x', publishAt });
      expect(res.status).toBe(401);
    });

    it('returns 400 when draft not found', async () => {
      mockAuth();
      mockScheduleDraft.mockResolvedValue(null);
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.schedulePost')
        .set('Authorization', AUTH_HEADER)
        .send({ uri, publishAt });
      expect(res.status).toBe(400);
    });
  });

  // ---- town.roundabout.scheduledPosts.publishPost ----

  describe('town.roundabout.scheduledPosts.publishPost', () => {
    const uri = `at://${USER_DID}/app.bsky.feed.post/abc123`;

    it('publishes a draft synchronously', async () => {
      mockAuth();
      mockGetDraft.mockResolvedValue(DRAFT_VIEW);
      mockPublishDraft.mockResolvedValue(undefined);
      const publishedView = { ...DRAFT_VIEW, status: 'published' as const };
      mockGetDraft.mockResolvedValueOnce(DRAFT_VIEW).mockResolvedValueOnce(publishedView);
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.publishPost')
        .set('Authorization', AUTH_HEADER)
        .send({ uri });
      expect(res.status).toBe(200);
      expect(mockPublishDraft).toHaveBeenCalledWith(uri, config);
    });

    it('returns 400 when uri is missing', async () => {
      mockAuth();
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.publishPost')
        .set('Authorization', AUTH_HEADER)
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 401 when draft belongs to another user', async () => {
      mockAuth();
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.publishPost')
        .set('Authorization', AUTH_HEADER)
        .send({ uri: 'at://did:plc:other/app.bsky.feed.post/x' });
      expect(res.status).toBe(401);
    });

    it('returns 400 when draft not found before publish', async () => {
      mockAuth();
      mockGetDraft.mockResolvedValue(null);
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.publishPost')
        .set('Authorization', AUTH_HEADER)
        .send({ uri });
      expect(res.status).toBe(400);
    });

    it('returns 400 when draft not found after publish', async () => {
      mockAuth();
      mockGetDraft.mockResolvedValueOnce(DRAFT_VIEW).mockResolvedValueOnce(null);
      mockPublishDraft.mockResolvedValue(undefined);
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.publishPost')
        .set('Authorization', AUTH_HEADER)
        .send({ uri });
      expect(res.status).toBe(400);
    });
  });

  // ---- town.roundabout.scheduledPosts.updatePost ----

  describe('town.roundabout.scheduledPosts.updatePost', () => {
    const uri = `at://${USER_DID}/app.bsky.feed.post/abc123`;

    it('updates a draft', async () => {
      mockAuth();
      mockUpdateDraft.mockResolvedValue({ ...DRAFT_VIEW, record: { $type: 'app.bsky.feed.post', text: 'updated' } });
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.updatePost')
        .set('Authorization', AUTH_HEADER)
        .send({ uri, record: { $type: 'app.bsky.feed.post', text: 'updated' } });
      expect(res.status).toBe(200);
    });

    it('updates scheduledAt', async () => {
      mockAuth();
      mockUpdateDraft.mockResolvedValue(DRAFT_VIEW);
      const futureTime = new Date(Date.now() + 60000).toISOString();
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.updatePost')
        .set('Authorization', AUTH_HEADER)
        .send({ uri, scheduledAt: futureTime });
      expect(res.status).toBe(200);
    });

    it('returns 400 when uri is missing', async () => {
      mockAuth();
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.updatePost')
        .set('Authorization', AUTH_HEADER)
        .send({ record: { text: 'hi' } });
      expect(res.status).toBe(400);
    });

    it('returns 400 when scheduledAt is not a valid date', async () => {
      mockAuth();
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.updatePost')
        .set('Authorization', AUTH_HEADER)
        .send({ uri, scheduledAt: 'not-a-date' });
      expect(res.status).toBe(400);
    });

    it('returns 401 when draft belongs to another user', async () => {
      mockAuth();
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.updatePost')
        .set('Authorization', AUTH_HEADER)
        .send({ uri: 'at://did:plc:other/app.bsky.feed.post/x' });
      expect(res.status).toBe(401);
    });

    it('returns 400 when draft not found', async () => {
      mockAuth();
      mockUpdateDraft.mockResolvedValue(null);
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.updatePost')
        .set('Authorization', AUTH_HEADER)
        .send({ uri });
      expect(res.status).toBe(400);
    });

    it('returns 400 when uri is not a valid AT-URI', async () => {
      mockAuth();
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.updatePost')
        .set('Authorization', AUTH_HEADER)
        .send({ uri: 'not-a-valid-at-uri' });
      expect(res.status).toBe(400);
    });
  });

  // ---- town.roundabout.scheduledPosts.deletePost ----

  describe('town.roundabout.scheduledPosts.deletePost', () => {
    const uri = `at://${USER_DID}/app.bsky.feed.post/abc123`;

    it('deletes a draft', async () => {
      mockAuth();
      mockCancelDraft.mockResolvedValue(undefined);
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.deletePost')
        .set('Authorization', AUTH_HEADER)
        .send({ uri });
      expect(res.status).toBe(200);
      expect(mockCancelDraft).toHaveBeenCalledWith(uri);
      expect(mockNotifyScheduler).toHaveBeenCalled();
    });

    it('returns 400 when uri is missing', async () => {
      mockAuth();
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.deletePost')
        .set('Authorization', AUTH_HEADER)
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 401 when draft belongs to another user', async () => {
      mockAuth();
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.deletePost')
        .set('Authorization', AUTH_HEADER)
        .send({ uri: 'at://did:plc:other/app.bsky.feed.post/x' });
      expect(res.status).toBe(401);
    });
  });

  // ---- DELETE /account ----

  describe('DELETE /account', () => {
    it('deletes user data and returns 200', async () => {
      mockAuth();
      mockDeleteUserData.mockResolvedValue(undefined);
      const res = await request(app)
        .delete('/account')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
      expect(mockDeleteUserData).toHaveBeenCalledWith(USER_DID);
    });

    it('returns 401 when not authenticated', async () => {
      mockVerifyRequestAuth.mockRejectedValue(new Error('Unauthorized'));
      const res = await request(app).delete('/account');
      expect(res.status).toBe(401);
    });
  });

  // ---- 404 handler ----

  describe('404 handler', () => {
    it('returns 404 for unknown routes', async () => {
      const res = await request(app).get('/totally/unknown/route');
      expect(res.status).toBe(404);
    });
  });
});
