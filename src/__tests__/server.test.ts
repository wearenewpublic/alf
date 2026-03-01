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
  getDraftRawRow: jest.fn(),
  getDraftByTriggerKeyHash: jest.fn(),
  listDrafts: jest.fn(),
  scheduleDraft: jest.fn(),
  updateDraft: jest.fn(),
  cancelDraft: jest.fn(),
  storeDraftBlob: jest.fn(),
  getUserAuthorization: jest.fn(),
  deleteUserData: jest.fn(),
  countActiveDraftsForUser: jest.fn(),
  createSchedule: jest.fn(),
  getSchedule: jest.fn(),
  getRawSchedule: jest.fn(),
  listSchedules: jest.fn(),
  updateSchedule: jest.fn(),
  updateScheduleStatus: jest.fn(),
  updateScheduleNextDraft: jest.fn(),
  deleteSchedule: jest.fn(),
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
import { createDraft, getDraft, getDraftRawRow, getDraftByTriggerKeyHash, listDrafts, scheduleDraft, updateDraft, cancelDraft, storeDraftBlob, getUserAuthorization, countActiveDraftsForUser, deleteUserData, createSchedule, getSchedule, getRawSchedule, listSchedules, updateSchedule, updateScheduleNextDraft, deleteSchedule } from '../storage';
import { publishDraft, notifyScheduler } from '../scheduler';

const mockVerifyRequestAuth = verifyRequestAuth as jest.Mock;
const mockExtractBearerToken = extractBearerToken as jest.Mock;
const mockExtractPdsUrlFromToken = extractPdsUrlFromToken as jest.Mock;
const mockVerifyDpopBoundToken = verifyDpopBoundToken as jest.Mock;
const mockCreateDraft = createDraft as jest.Mock;
const mockGetDraft = getDraft as jest.Mock;
const mockGetDraftRawRow = getDraftRawRow as jest.Mock;
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
  oauthScope: 'atproto repo:*?action=create blob:*/*',
};

const AUTH_HEADER = 'Bearer test-token';
const USER_DID = 'did:plc:alice';

function mockAuth() {
  mockExtractBearerToken.mockReturnValue('test-token');
  mockExtractPdsUrlFromToken.mockReturnValue('http://localhost:2583');
  mockVerifyRequestAuth.mockResolvedValue({ did: USER_DID });
  mockVerifyDpopBoundToken.mockResolvedValue({ did: USER_DID });
  mockCountActiveDraftsForUser.mockResolvedValue(0);
  // Default: no trigger key, no schedule association
  mockGetDraftRawRow.mockResolvedValue(null);
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

  // ---- Webhook trigger ----

  describe('POST /triggers/:key', () => {
    beforeEach(() => {
      mockAuth();
    });

    it('returns 404 when trigger key not found', async () => {
      (getDraftByTriggerKeyHash as jest.Mock).mockResolvedValue(null);
      const res = await request(app).post('/triggers/unknownkey');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NotFound');
    });

    it('returns 409 when draft is already in terminal state', async () => {
      (getDraftByTriggerKeyHash as jest.Mock).mockResolvedValue({
        uri: DRAFT_VIEW.uri,
        status: 'published',
        schedule_id: null,
      });
      const res = await request(app).post('/triggers/somekey');
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('TriggerAlreadyFired');
    });

    it('publishes the draft and returns 200 on valid key', async () => {
      (getDraftByTriggerKeyHash as jest.Mock).mockResolvedValue({
        uri: DRAFT_VIEW.uri,
        status: 'draft',
        schedule_id: null,
      });
      (mockPublishDraft as jest.Mock).mockResolvedValue(undefined);
      mockGetDraft.mockResolvedValue({ ...DRAFT_VIEW, status: 'published' });

      const res = await request(app).post('/triggers/test-trigger-key');
      expect(res.status).toBe(200);
      expect(res.body.published).toBe(true);
    });

    it('returns 500 when publishDraft succeeds but draft status is not published', async () => {
      (getDraftByTriggerKeyHash as jest.Mock).mockResolvedValue({
        uri: DRAFT_VIEW.uri,
        status: 'draft',
        schedule_id: null,
      });
      (mockPublishDraft as jest.Mock).mockResolvedValue(undefined);
      mockGetDraft.mockResolvedValue({ ...DRAFT_VIEW, status: 'failed', failureReason: 'Malformed token' });

      const res = await request(app).post('/triggers/test-trigger-key');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('PublishFailed');
      expect(res.body.message).toBe('Malformed token');
      expect(res.body.status).toBe('failed');
    });
  });

  // ---- createRecord with x-trigger: webhook header ----

  describe('com.atproto.repo.createRecord with x-trigger: webhook', () => {
    beforeEach(() => {
      mockAuth();
      mockCreateDraft.mockResolvedValue(DRAFT_VIEW);
    });

    it('returns triggerUrl in response when x-trigger: webhook header is set', async () => {
      const res = await request(app)
        .post('/xrpc/com.atproto.repo.createRecord')
        .set('Authorization', AUTH_HEADER)
        .set('x-trigger', 'webhook')
        .send({ repo: USER_DID, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: 'hello' } });
      expect(res.status).toBe(200);
      expect(res.body.triggerUrl).toBeDefined();
      expect(res.body.triggerUrl).toMatch(/^http:\/\/localhost:1986\/triggers\//);
    });

    it('does not include triggerUrl when x-trigger header is absent', async () => {
      const res = await request(app)
        .post('/xrpc/com.atproto.repo.createRecord')
        .set('Authorization', AUTH_HEADER)
        .send({ repo: USER_DID, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: 'hello' } });
      expect(res.status).toBe(200);
      expect(res.body.triggerUrl).toBeUndefined();
    });
  });

  // ---- getPost returns triggerUrl when draft has webhook key ----

  describe('town.roundabout.scheduledPosts.getPost with trigger key', () => {
    beforeEach(() => {
      mockAuth();
    });

    it('includes triggerUrl in response when draft has trigger_key_encrypted', async () => {
      const uri = DRAFT_VIEW.uri;
      mockGetDraft.mockResolvedValue(DRAFT_VIEW);
      // Provide a raw row with an encrypted trigger key
      // We encrypt using the same key as config.encryptionKey = 'a'.repeat(64)
      const { encrypt } = jest.requireActual('../encrypt') as typeof import('../encrypt');
      const plainKey = 'test-uuid-key-1234';
      const encryptedKey = encrypt(plainKey, 'a'.repeat(64));
      mockGetDraftRawRow.mockResolvedValue({
        uri,
        trigger_key_encrypted: encryptedKey,
        trigger_key_hash: 'somehash',
        schedule_id: null,
      });

      const res = await request(app)
        .get(`/xrpc/town.roundabout.scheduledPosts.getPost?uri=${encodeURIComponent(uri)}`)
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(200);
      expect(res.body.triggerUrl).toBe(`http://localhost:1986/triggers/${plainKey}`);
    });

    it('omits triggerUrl when raw row has no trigger_key_encrypted', async () => {
      const uri = DRAFT_VIEW.uri;
      mockGetDraft.mockResolvedValue(DRAFT_VIEW);
      mockGetDraftRawRow.mockResolvedValue({ uri, trigger_key_encrypted: null, schedule_id: null });

      const res = await request(app)
        .get(`/xrpc/town.roundabout.scheduledPosts.getPost?uri=${encodeURIComponent(uri)}`)
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(200);
      expect(res.body.triggerUrl).toBeUndefined();
    });
  });

  // ---- Schedule XRPC endpoints ----

  describe('town.roundabout.scheduledPosts.createSchedule', () => {
    const DAILY_RULE = {
      rule: {
        type: 'daily',
        time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'UTC' },
      },
    };

    const SCHEDULE_VIEW = {
      id: 'sched-uuid',
      collection: 'app.bsky.feed.post',
      status: 'active',
      recurrenceRule: DAILY_RULE,
      timezone: 'UTC',
      fireCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nextDraftUri: DRAFT_VIEW.uri,
    };

    beforeEach(() => {
      mockAuth();
      (createSchedule as jest.Mock).mockResolvedValue({ id: 'sched-uuid' });
      mockCreateDraft.mockResolvedValue(DRAFT_VIEW);
      (updateScheduleNextDraft as jest.Mock).mockResolvedValue(undefined);
      (getSchedule as jest.Mock).mockResolvedValue(SCHEDULE_VIEW);
    });

    it('creates a schedule and returns scheduleView', async () => {
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.createSchedule')
        .set('Authorization', AUTH_HEADER)
        .send({
          collection: 'app.bsky.feed.post',
          recurrenceRule: DAILY_RULE,
          timezone: 'UTC',
          record: { $type: 'app.bsky.feed.post', text: 'scheduled' },
        });
      expect(res.status).toBe(200);
      expect(res.body.schedule).toBeDefined();
      expect(res.body.schedule.id).toBe('sched-uuid');
    });

    it('creates a schedule with contentUrl (dynamic schedule, no record)', async () => {
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.createSchedule')
        .set('Authorization', AUTH_HEADER)
        .send({
          collection: 'app.bsky.feed.post',
          recurrenceRule: DAILY_RULE,
          timezone: 'UTC',
          contentUrl: 'https://example.com/dynamic-content',
        });
      expect(res.status).toBe(200);
    });

    it('rejects when both record and contentUrl provided', async () => {
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.createSchedule')
        .set('Authorization', AUTH_HEADER)
        .send({
          collection: 'app.bsky.feed.post',
          recurrenceRule: DAILY_RULE,
          timezone: 'UTC',
          record: { $type: 'app.bsky.feed.post', text: 'hi' },
          contentUrl: 'https://example.com/content',
        });
      expect(res.status).toBe(400);
    });

    it('requires auth', async () => {
      mockVerifyRequestAuth.mockRejectedValue(new Error('Unauthorized'));
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.createSchedule')
        .send({ collection: 'app.bsky.feed.post', recurrenceRule: DAILY_RULE, timezone: 'UTC' });
      expect(res.status).toBe(401);
    });
  });

  describe('town.roundabout.scheduledPosts.listSchedules', () => {
    beforeEach(() => {
      mockAuth();
      (listSchedules as jest.Mock).mockResolvedValue({ schedules: [], cursor: undefined });
    });

    it('lists schedules for the authenticated user', async () => {
      const res = await request(app)
        .get(`/xrpc/town.roundabout.scheduledPosts.listSchedules?repo=${USER_DID}`)
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(200);
      expect(res.body.schedules).toEqual([]);
    });

    it('rejects listing another user schedules', async () => {
      const res = await request(app)
        .get('/xrpc/town.roundabout.scheduledPosts.listSchedules?repo=did:plc:other')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(401);
    });
  });

  describe('town.roundabout.scheduledPosts.getSchedule', () => {
    const SCHEDULE_VIEW = {
      id: 'sched-uuid',
      collection: 'app.bsky.feed.post',
      status: 'active',
      recurrenceRule: {},
      timezone: 'UTC',
      fireCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    beforeEach(() => {
      mockAuth();
      (getSchedule as jest.Mock).mockResolvedValue(SCHEDULE_VIEW);
      (getRawSchedule as jest.Mock).mockResolvedValue({ user_did: USER_DID });
    });

    it('returns the schedule', async () => {
      const res = await request(app)
        .get('/xrpc/town.roundabout.scheduledPosts.getSchedule?id=sched-uuid')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(200);
      expect(res.body.schedule.id).toBe('sched-uuid');
    });

    it('returns 404 for non-existent schedule', async () => {
      (getSchedule as jest.Mock).mockResolvedValue(null);
      const res = await request(app)
        .get('/xrpc/town.roundabout.scheduledPosts.getSchedule?id=missing')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(400);
    });

    it('rejects access to another user schedule', async () => {
      (getRawSchedule as jest.Mock).mockResolvedValue({ user_did: 'did:plc:other' });
      const res = await request(app)
        .get('/xrpc/town.roundabout.scheduledPosts.getSchedule?id=sched-uuid')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(401);
    });
  });

  describe('town.roundabout.scheduledPosts.deleteSchedule', () => {
    beforeEach(() => {
      mockAuth();
      (getRawSchedule as jest.Mock).mockResolvedValue({ user_did: USER_DID });
      (deleteSchedule as jest.Mock).mockResolvedValue(undefined);
    });

    it('deletes the schedule', async () => {
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.deleteSchedule')
        .set('Authorization', AUTH_HEADER)
        .send({ id: 'sched-uuid' });
      expect(res.status).toBe(200);
      expect(deleteSchedule as jest.Mock).toHaveBeenCalledWith('sched-uuid');
    });

    it('returns 404 for non-existent schedule', async () => {
      (getRawSchedule as jest.Mock).mockResolvedValue(null);
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.deleteSchedule')
        .set('Authorization', AUTH_HEADER)
        .send({ id: 'missing' });
      expect(res.status).toBe(400);
    });

    it('rejects deletion of another user schedule', async () => {
      (getRawSchedule as jest.Mock).mockResolvedValue({ user_did: 'did:plc:other' });
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.deleteSchedule')
        .set('Authorization', AUTH_HEADER)
        .send({ id: 'sched-uuid' });
      expect(res.status).toBe(401);
    });
  });

  // ---- town.roundabout.scheduledPosts.updateSchedule ----

  describe('town.roundabout.scheduledPosts.updateSchedule', () => {
    const DAILY_RULE = {
      rule: {
        type: 'daily',
        time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'UTC' },
      },
    };
    const SCHEDULE_VIEW = {
      id: 'sched-uuid',
      collection: 'app.bsky.feed.post',
      status: 'active',
      recurrenceRule: DAILY_RULE,
      timezone: 'UTC',
      fireCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    beforeEach(() => {
      mockAuth();
      (getRawSchedule as jest.Mock).mockResolvedValue({
        user_did: USER_DID,
        status: 'active',
        next_draft_uri: null,
        collection: 'app.bsky.feed.post',
        record: null,
        content_url: null,
        recurrence_rule: JSON.stringify(DAILY_RULE),
      });
      (updateSchedule as jest.Mock).mockResolvedValue(SCHEDULE_VIEW);
      (cancelDraft as jest.Mock).mockResolvedValue(undefined);
      (updateScheduleNextDraft as jest.Mock).mockResolvedValue(undefined);
      mockCreateDraft.mockResolvedValue(DRAFT_VIEW);
    });

    it('returns 400 for non-existent schedule', async () => {
      (getRawSchedule as jest.Mock).mockResolvedValue(null);
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.updateSchedule')
        .set('Authorization', AUTH_HEADER)
        .send({ id: 'missing' });
      expect(res.status).toBe(400);
    });

    it('rejects update of another user schedule', async () => {
      (getRawSchedule as jest.Mock).mockResolvedValue({ user_did: 'did:plc:other', status: 'active' });
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.updateSchedule')
        .set('Authorization', AUTH_HEADER)
        .send({ id: 'sched-uuid' });
      expect(res.status).toBe(401);
    });

    it('updates recurrenceRule and timezone', async () => {
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.updateSchedule')
        .set('Authorization', AUTH_HEADER)
        .send({ id: 'sched-uuid', recurrenceRule: DAILY_RULE, timezone: 'America/New_York' });
      expect(res.status).toBe(200);
      expect(res.body.schedule).toBeDefined();
    });

    it('pauses an active schedule and cancels pending draft', async () => {
      (getRawSchedule as jest.Mock).mockResolvedValue({
        user_did: USER_DID,
        status: 'active',
        next_draft_uri: DRAFT_VIEW.uri,
        collection: 'app.bsky.feed.post',
        record: null,
        content_url: null,
        recurrence_rule: JSON.stringify(DAILY_RULE),
      });
      (updateSchedule as jest.Mock).mockResolvedValue({ ...SCHEDULE_VIEW, status: 'paused' });

      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.updateSchedule')
        .set('Authorization', AUTH_HEADER)
        .send({ id: 'sched-uuid', status: 'paused' });
      expect(res.status).toBe(200);
      expect(cancelDraft as jest.Mock).toHaveBeenCalledWith(DRAFT_VIEW.uri);
      expect(updateScheduleNextDraft as jest.Mock).toHaveBeenCalledWith('sched-uuid', null);
    });

    it('pauses an active schedule with no pending draft', async () => {
      // next_draft_uri is null — no cancelDraft call needed
      (updateSchedule as jest.Mock).mockResolvedValue({ ...SCHEDULE_VIEW, status: 'paused' });
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.updateSchedule')
        .set('Authorization', AUTH_HEADER)
        .send({ id: 'sched-uuid', status: 'paused' });
      expect(res.status).toBe(200);
      expect(cancelDraft as jest.Mock).not.toHaveBeenCalled();
    });

    it('resumes a paused schedule and creates a new draft', async () => {
      (getRawSchedule as jest.Mock).mockResolvedValue({
        user_did: USER_DID,
        status: 'paused',
        next_draft_uri: null,
        collection: 'app.bsky.feed.post',
        record: JSON.stringify({ $type: 'app.bsky.feed.post', text: 'resumed' }),
        content_url: null,
        recurrence_rule: JSON.stringify(DAILY_RULE),
      });
      (updateSchedule as jest.Mock).mockResolvedValue({ ...SCHEDULE_VIEW, status: 'active' });

      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.updateSchedule')
        .set('Authorization', AUTH_HEADER)
        .send({ id: 'sched-uuid', status: 'active' });
      expect(res.status).toBe(200);
      expect(mockCreateDraft).toHaveBeenCalled();
      expect(updateScheduleNextDraft as jest.Mock).toHaveBeenCalled();
      expect(mockNotifyScheduler).toHaveBeenCalled();
    });

    it('resumes a paused schedule with contentUrl (null record)', async () => {
      (getRawSchedule as jest.Mock).mockResolvedValue({
        user_did: USER_DID,
        status: 'paused',
        next_draft_uri: null,
        collection: 'app.bsky.feed.post',
        record: null,
        content_url: 'https://example.com/content',
        recurrence_rule: JSON.stringify(DAILY_RULE),
      });
      (updateSchedule as jest.Mock).mockResolvedValue({ ...SCHEDULE_VIEW, status: 'active' });

      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.updateSchedule')
        .set('Authorization', AUTH_HEADER)
        .send({ id: 'sched-uuid', status: 'active' });
      expect(res.status).toBe(200);
      expect(mockCreateDraft).toHaveBeenCalled();
    });

    it('resumes a paused schedule with an updated recurrenceRule', async () => {
      (getRawSchedule as jest.Mock).mockResolvedValue({
        user_did: USER_DID,
        status: 'paused',
        next_draft_uri: null,
        collection: 'app.bsky.feed.post',
        record: null,
        content_url: null,
        recurrence_rule: JSON.stringify(DAILY_RULE),
      });
      (updateSchedule as jest.Mock).mockResolvedValue({ ...SCHEDULE_VIEW, status: 'active' });

      const newRule = {
        rule: { type: 'weekly', daysOfWeek: [1], time: { type: 'wall_time', hour: 10, minute: 0, timezone: 'UTC' } },
      };
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.updateSchedule')
        .set('Authorization', AUTH_HEADER)
        .send({ id: 'sched-uuid', status: 'active', recurrenceRule: newRule });
      expect(res.status).toBe(200);
      expect(mockCreateDraft).toHaveBeenCalled();
    });

    it('does not create draft when resuming schedule with no future occurrences', async () => {
      const exhaustedRule = {
        rule: { type: 'daily', time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'UTC' } },
        endDate: '2020-01-01',
      };
      (getRawSchedule as jest.Mock).mockResolvedValue({
        user_did: USER_DID,
        status: 'paused',
        next_draft_uri: null,
        collection: 'app.bsky.feed.post',
        record: null,
        content_url: null,
        recurrence_rule: JSON.stringify(DAILY_RULE),
      });
      (updateSchedule as jest.Mock).mockResolvedValue({ ...SCHEDULE_VIEW, status: 'active' });

      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.updateSchedule')
        .set('Authorization', AUTH_HEADER)
        .send({ id: 'sched-uuid', status: 'active', recurrenceRule: exhaustedRule });
      expect(res.status).toBe(200);
      // No new draft when exhausted rule
      expect(mockCreateDraft).not.toHaveBeenCalled();
    });

    it('updates record content', async () => {
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.updateSchedule')
        .set('Authorization', AUTH_HEADER)
        .send({ id: 'sched-uuid', record: { $type: 'app.bsky.feed.post', text: 'new' } });
      expect(res.status).toBe(200);
    });

    it('updates contentUrl to new value', async () => {
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.updateSchedule')
        .set('Authorization', AUTH_HEADER)
        .send({ id: 'sched-uuid', contentUrl: 'https://example.com/new-content' });
      expect(res.status).toBe(200);
    });

    it('sets status directly when status is defined but neither pause nor resume case matches', async () => {
      // When raw.status === 'paused' and body.status === 'paused', neither the
      // pause (active→paused) nor resume (paused→active) branch fires.
      // The else-if branch executes: updateParams.status = body.status
      (getRawSchedule as jest.Mock).mockResolvedValue({
        user_did: USER_DID,
        status: 'paused',
        next_draft_uri: null,
        collection: 'app.bsky.feed.post',
        record: null,
        content_url: null,
        recurrence_rule: JSON.stringify({
          rule: { type: 'daily', time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'UTC' } },
        }),
      });
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.updateSchedule')
        .set('Authorization', AUTH_HEADER)
        .send({ id: 'sched-uuid', status: 'paused' });
      expect(res.status).toBe(200);
    });

    it('requires auth', async () => {
      mockVerifyRequestAuth.mockRejectedValue(new Error('Unauthorized'));
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.updateSchedule')
        .send({ id: 'sched-uuid' });
      expect(res.status).toBe(401);
    });
  });

  // ---- POST /triggers/:key catch block ----

  describe('POST /triggers/:key error handling', () => {
    it('returns 500 when publishDraft throws', async () => {
      (getDraftByTriggerKeyHash as jest.Mock).mockResolvedValue({
        uri: DRAFT_VIEW.uri,
        status: 'draft',
        schedule_id: null,
      });
      (mockPublishDraft as jest.Mock).mockRejectedValue(new Error('PDS unreachable'));

      const res = await request(app).post('/triggers/some-key');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('InternalError');
    });
  });

  // ---- putRecord with x-trigger: webhook ----

  describe('com.atproto.repo.putRecord with x-trigger: webhook', () => {
    beforeEach(() => {
      mockAuth();
      mockCreateDraft.mockResolvedValue({ ...DRAFT_VIEW, action: 'put' });
    });

    it('returns triggerUrl in response when x-trigger: webhook is set', async () => {
      const res = await request(app)
        .post('/xrpc/com.atproto.repo.putRecord')
        .set('Authorization', AUTH_HEADER)
        .set('x-trigger', 'webhook')
        .send({ repo: USER_DID, collection: 'app.bsky.feed.post', rkey: 'abc', record: { $type: 'app.bsky.feed.post', text: 'put' } });
      expect(res.status).toBe(200);
      expect(res.body.triggerUrl).toBeDefined();
      expect(res.body.triggerUrl).toMatch(/^http:\/\/localhost:1986\/triggers\//);
    });
  });

  // ---- deleteRecord with x-trigger: webhook ----

  describe('com.atproto.repo.deleteRecord with x-trigger: webhook', () => {
    beforeEach(() => {
      mockAuth();
      mockCreateDraft.mockResolvedValue({ ...DRAFT_VIEW, action: 'delete' });
    });

    it('returns triggerUrl in response when x-trigger: webhook is set', async () => {
      const res = await request(app)
        .post('/xrpc/com.atproto.repo.deleteRecord')
        .set('Authorization', AUTH_HEADER)
        .set('x-trigger', 'webhook')
        .send({ repo: USER_DID, collection: 'app.bsky.feed.post', rkey: 'abc' });
      expect(res.status).toBe(200);
      expect(res.body.triggerUrl).toBeDefined();
      expect(res.body.triggerUrl).toMatch(/^http:\/\/localhost:1986\/triggers\//);
    });
  });

  // ---- listPosts with decryption failure ----

  describe('town.roundabout.scheduledPosts.listPosts with trigger key decryption failure', () => {
    it('omits triggerUrl for a draft when decryption fails', async () => {
      mockAuth();
      // Return a draft with an invalid/corrupt encrypted key
      mockListDrafts.mockResolvedValue({
        drafts: [{ ...DRAFT_VIEW, triggerKeyEncrypted: 'invalid:not:base64!!!' }],
        cursor: undefined,
      });

      const res = await request(app)
        .get(`/xrpc/town.roundabout.scheduledPosts.listPosts?repo=${USER_DID}`)
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(200);
      // triggerUrl should be omitted when decryption fails
      expect(res.body.posts[0].triggerUrl).toBeUndefined();
    });
  });

  // ---- listPosts with trigger key decryption success ----

  describe('town.roundabout.scheduledPosts.listPosts with valid trigger key', () => {
    it('includes triggerUrl in post when decryption succeeds', async () => {
      mockAuth();
      const plainKey = 'some-webhook-uuid-key';
      const { encrypt } = jest.requireActual('../encrypt') as typeof import('../encrypt');
      const encryptedKey = encrypt(plainKey, config.encryptionKey);

      mockListDrafts.mockResolvedValue({
        drafts: [{ ...DRAFT_VIEW, triggerKeyEncrypted: encryptedKey }],
        cursor: undefined,
      });

      const res = await request(app)
        .get(`/xrpc/town.roundabout.scheduledPosts.listPosts?repo=${USER_DID}`)
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(200);
      expect(res.body.posts[0].triggerUrl).toBe(`http://localhost:1986/triggers/${plainKey}`);
    });
  });

  // ---- getPost with trigger key decryption failure ----

  describe('town.roundabout.scheduledPosts.getPost with trigger key decryption failure', () => {
    it('omits triggerUrl when decryption fails', async () => {
      mockAuth();
      const uri = DRAFT_VIEW.uri;
      mockGetDraft.mockResolvedValue(DRAFT_VIEW);
      // Provide a corrupted encrypted key
      mockGetDraftRawRow.mockResolvedValue({
        uri,
        trigger_key_encrypted: 'corrupt:invalid:garbage!!!',
        trigger_key_hash: 'somehash',
        schedule_id: null,
      });

      const res = await request(app)
        .get(`/xrpc/town.roundabout.scheduledPosts.getPost?uri=${encodeURIComponent(uri)}`)
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(200);
      expect(res.body.triggerUrl).toBeUndefined();
    });
  });

  // ---- createSchedule with invalid/exhausted recurrence rule ----

  describe('town.roundabout.scheduledPosts.createSchedule with invalid rule', () => {
    it('returns 400 when recurrence rule has no future occurrences', async () => {
      mockAuth();
      const exhaustedRule = {
        rule: {
          type: 'daily',
          time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'UTC' },
        },
        endDate: '2020-01-01',
      };
      const res = await request(app)
        .post('/xrpc/town.roundabout.scheduledPosts.createSchedule')
        .set('Authorization', AUTH_HEADER)
        .send({
          collection: 'app.bsky.feed.post',
          recurrenceRule: exhaustedRule,
          timezone: 'UTC',
          record: { $type: 'app.bsky.feed.post', text: 'hi' },
        });
      expect(res.status).toBe(400);
    });
  });
});
