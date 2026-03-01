// Tests for the background scheduler

import { Kysely } from 'kysely';
import type { ServiceConfig } from '../config';
import { createDb, initializeSchema } from '../database';
import * as storage from '../storage';

const {
  setDb,
  createDraft,
  getDraft,
  getReadyDrafts,
  upsertUserAuthorization,
  storeDraftBlob,
  createSchedule,
  getRawSchedule,
  updateScheduleNextDraft,
} = storage;
import { setOAuthClient } from '../oauth';
import { publishDraft, startScheduler, stopScheduler, notifyScheduler } from '../scheduler';
import type { Database } from '../schema';

// Mock oauth module
jest.mock('../oauth', () => ({
  setOAuthClient: jest.fn(),
  getOAuthClient: jest.fn(),
}));

// Mock @atproto/api
jest.mock('@atproto/api', () => ({
  Agent: jest.fn(),
}));

const { getOAuthClient } = jest.requireMock('../oauth') as {
  getOAuthClient: jest.Mock;
  setOAuthClient: jest.Mock;
};

const { Agent } = jest.requireMock('@atproto/api') as {
  Agent: jest.Mock;
};

const createMockConfig = (): ServiceConfig => ({
  port: 3005,
  serviceUrl: 'http://localhost:3005',
  plcRoot: 'http://localhost:2582',
  handleResolverUrl: 'http://localhost:2583',
  databaseType: 'sqlite',
  databasePath: ':memory:',
  databaseUrl: undefined,
  encryptionKey: 'a'.repeat(64),
  maxDraftsPerUser: null,
  allowedCollections: '*',
  oauthScope: 'atproto repo:*?action=create blob:*/*',
});

/** Flush all pending microtasks and I/O callbacks */
const flushPromises = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('scheduler', () => {
  let db: Kysely<Database>;
  const config = createMockConfig();

  beforeEach(async () => {
    jest.clearAllMocks();
    db = createDb(config);
    await initializeSchema(db, config);
    setDb(db);
    setOAuthClient({} as never);
  });

  afterEach(async () => {
    stopScheduler();
    await db.destroy();
  });

  describe('publishDraft', () => {
    beforeEach(async () => {
      // Seed an OAuth authorization record so publishDraft can proceed past the auth guard
      await upsertUserAuthorization({
        userDid: 'did:plc:alice',
        pdsUrl: 'https://pds.example.com',
        refreshToken: 'encrypted-token',
        dpopPrivateKey: 'encrypted-key',
        tokenScope: 'atproto',
      });
    });

    it('should publish a create draft successfully', async () => {
      const mockSession = {
        sub: 'did:plc:alice',
        serverMetadata: { issuer: 'https://pds.example.com' },
      };
      const mockCreateRecord = jest.fn().mockResolvedValue({
        data: { uri: 'at://did:plc:alice/app.bsky.feed.post/abc', cid: 'bafy123' },
      });
      const mockAgent = {
        com: { atproto: { repo: { createRecord: mockCreateRecord } } },
      };

      getOAuthClient.mockReturnValue({
        restore: jest.fn().mockResolvedValue(mockSession),
      });
      Agent.mockReturnValue(mockAgent);

      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/pub1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'pub1',
        record: { $type: 'app.bsky.feed.post', text: 'hello' },
        recordCid: 'bafyhello',
        action: 'create',
      });

      await publishDraft('at://did:plc:alice/app.bsky.feed.post/pub1', config);

      const draft = await getDraft('at://did:plc:alice/app.bsky.feed.post/pub1');
      expect(draft?.status).toBe('published');
    });

    it('should publish a delete draft successfully', async () => {
      const mockSession = {
        sub: 'did:plc:alice',
        serverMetadata: { issuer: 'https://pds.example.com' },
      };
      const mockDeleteRecord = jest.fn().mockResolvedValue({});
      const mockAgent = {
        com: { atproto: { repo: { deleteRecord: mockDeleteRecord } } },
      };

      getOAuthClient.mockReturnValue({
        restore: jest.fn().mockResolvedValue(mockSession),
      });
      Agent.mockReturnValue(mockAgent);

      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/del1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'del1',
        record: null,
        recordCid: null,
        action: 'delete',
      });

      await publishDraft('at://did:plc:alice/app.bsky.feed.post/del1', config);

      const draft = await getDraft('at://did:plc:alice/app.bsky.feed.post/del1');
      expect(draft?.status).toBe('published');
      expect(mockDeleteRecord).toHaveBeenCalledWith({
        repo: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'del1',
      });
    });

    it('should not republish an already-claimed draft', async () => {
      getOAuthClient.mockReturnValue({
        restore: jest.fn().mockResolvedValue({
          sub: 'did:plc:alice',
          serverMetadata: { issuer: 'https://pds.example.com' },
        }),
      });
      const mockCreateRecord = jest.fn().mockResolvedValue({});
      Agent.mockReturnValue({
        com: { atproto: { repo: { createRecord: mockCreateRecord } } },
      });

      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/dup1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'dup1',
        record: { text: 'hello' },
        recordCid: 'bafydup',
        action: 'create',
      });

      // Simulate two concurrent publishDraft calls
      await Promise.all([
        publishDraft('at://did:plc:alice/app.bsky.feed.post/dup1', config),
        publishDraft('at://did:plc:alice/app.bsky.feed.post/dup1', config),
      ]);

      // Should only have published once
      expect(mockCreateRecord).toHaveBeenCalledTimes(1);
    });

    it('should increment retry count and reschedule on failure', async () => {
      getOAuthClient.mockReturnValue({
        restore: jest.fn().mockResolvedValue({
          sub: 'did:plc:alice',
          serverMetadata: { issuer: 'https://pds.example.com' },
        }),
      });
      const mockCreateRecord = jest.fn().mockRejectedValue(new Error('PDS unavailable'));
      Agent.mockReturnValue({
        com: { atproto: { repo: { createRecord: mockCreateRecord } } },
      });

      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/retry1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'retry1',
        record: { text: 'hello' },
        recordCid: 'bafyretry',
        action: 'create',
      });

      await publishDraft('at://did:plc:alice/app.bsky.feed.post/retry1', config);

      const draft = await getDraft('at://did:plc:alice/app.bsky.feed.post/retry1');
      // First failure: should be rescheduled (retry_count = 1, status = 'scheduled')
      expect(draft?.status).toBe('scheduled');
      expect(draft?.failureReason).toBe('PDS unavailable');
    });

    it('should mark as failed after MAX_RETRIES exhausted', async () => {
      getOAuthClient.mockReturnValue({
        restore: jest.fn().mockResolvedValue({
          sub: 'did:plc:alice',
          serverMetadata: { issuer: 'https://pds.example.com' },
        }),
      });
      Agent.mockReturnValue({
        com: { atproto: { repo: { createRecord: jest.fn().mockRejectedValue(new Error('PDS error')) } } },
      });

      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/exhaust1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'exhaust1',
        record: { text: 'hello' },
        recordCid: 'bafyexhaust',
        action: 'create',
      });

      // Manually set retry_count to 2 (one below max)
      await db
        .updateTable('drafts')
        .set({ retry_count: 2 })
        .where('uri', '=', 'at://did:plc:alice/app.bsky.feed.post/exhaust1')
        .execute();

      await publishDraft('at://did:plc:alice/app.bsky.feed.post/exhaust1', config);

      const draft = await getDraft('at://did:plc:alice/app.bsky.feed.post/exhaust1');
      expect(draft?.status).toBe('failed');
    });

    it('should publish a put draft successfully', async () => {
      const mockSession = {
        sub: 'did:plc:alice',
        serverMetadata: { issuer: 'https://pds.example.com' },
      };
      const mockPutRecord = jest.fn().mockResolvedValue({
        data: { uri: 'at://did:plc:alice/app.bsky.feed.post/put1', cid: 'bafyput' },
      });
      const mockAgent = {
        com: { atproto: { repo: { putRecord: mockPutRecord } } },
        uploadBlob: jest.fn(),
      };

      getOAuthClient.mockReturnValue({
        restore: jest.fn().mockResolvedValue(mockSession),
      });
      Agent.mockReturnValue(mockAgent);

      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/put1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'put1',
        record: { $type: 'app.bsky.feed.post', text: 'put hello' },
        recordCid: 'bafyput',
        action: 'put',
      });

      await publishDraft('at://did:plc:alice/app.bsky.feed.post/put1', config);

      const draft = await getDraft('at://did:plc:alice/app.bsky.feed.post/put1');
      expect(draft?.status).toBe('published');
      expect(mockPutRecord).toHaveBeenCalled();
    });

    it('should set createdAt/scheduledAt on record when draft has scheduledAt', async () => {
      const mockSession = { sub: 'did:plc:alice', serverMetadata: { issuer: 'https://pds.example.com' } };
      const mockCreateRecord = jest.fn().mockResolvedValue({ data: {} });
      const mockAgent = {
        com: { atproto: { repo: { createRecord: mockCreateRecord } } },
        uploadBlob: jest.fn(),
      };
      getOAuthClient.mockReturnValue({ restore: jest.fn().mockResolvedValue(mockSession) });
      Agent.mockReturnValue(mockAgent);

      const scheduledAt = Date.now() + 1000;
      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/sched2',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'sched2',
        record: { $type: 'app.bsky.feed.post', text: 'scheduled' },
        recordCid: 'bafysched2',
        action: 'create',
        scheduledAt,
      });

      await publishDraft('at://did:plc:alice/app.bsky.feed.post/sched2', config);

      const passedRecord = mockCreateRecord.mock.calls[0][0].record as Record<string, unknown>;
      expect(passedRecord.createdAt).toBeDefined();
    });

    it('should re-upload blobs and call uploadBlob before publishing', async () => {
      const mockSession = { sub: 'did:plc:alice', serverMetadata: { issuer: 'https://pds.example.com' } };
      const mockCreateRecord = jest.fn().mockResolvedValue({ data: {} });
      const mockUploadBlob = jest.fn().mockResolvedValue({});
      const mockAgent = {
        com: { atproto: { repo: { createRecord: mockCreateRecord } } },
        uploadBlob: mockUploadBlob,
      };
      getOAuthClient.mockReturnValue({ restore: jest.fn().mockResolvedValue(mockSession) });
      Agent.mockReturnValue(mockAgent);

      const blobCid = 'bafyblob123';
      const record = {
        $type: 'app.bsky.feed.post',
        text: 'with blob',
        embed: {
          $type: 'app.bsky.embed.images',
          images: [{ image: { $type: 'blob', ref: { $link: blobCid }, mimeType: 'image/jpeg', size: 10 }, alt: '' }],
        },
      };

      await storeDraftBlob('did:plc:alice', blobCid, Buffer.from('imgdata'), 'image/jpeg', 7);
      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/blob1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'blob1',
        record,
        recordCid: 'bafyblobpost',
        action: 'create',
      });

      await publishDraft('at://did:plc:alice/app.bsky.feed.post/blob1', config);

      expect(mockUploadBlob).toHaveBeenCalled();
      const draft = await getDraft('at://did:plc:alice/app.bsky.feed.post/blob1');
      expect(draft?.status).toBe('published');
    });

    it('should continue publishing when blob re-upload fails', async () => {
      const mockSession = { sub: 'did:plc:alice', serverMetadata: { issuer: 'https://pds.example.com' } };
      const mockCreateRecord = jest.fn().mockResolvedValue({ data: {} });
      // uploadBlob rejects — non-fatal, publish should still succeed
      const mockUploadBlob = jest.fn().mockRejectedValue(new Error('upload failed'));
      const mockAgent = {
        com: { atproto: { repo: { createRecord: mockCreateRecord } } },
        uploadBlob: mockUploadBlob,
      };
      getOAuthClient.mockReturnValue({ restore: jest.fn().mockResolvedValue(mockSession) });
      Agent.mockReturnValue(mockAgent);

      const blobCid = 'bafybloberr';
      const record = {
        $type: 'app.bsky.feed.post',
        text: 'blob error post',
        embed: {
          $type: 'app.bsky.embed.images',
          images: [{ image: { $type: 'blob', ref: { $link: blobCid }, mimeType: 'image/jpeg', size: 10 }, alt: '' }],
        },
      };

      await storeDraftBlob('did:plc:alice', blobCid, Buffer.from('imgdata'), 'image/jpeg', 7);
      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/bloberr1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'bloberr1',
        record,
        recordCid: 'bafybloberrpost',
        action: 'create',
      });

      // Should resolve without throwing even though blob upload failed
      await expect(publishDraft('at://did:plc:alice/app.bsky.feed.post/bloberr1', config)).resolves.toBeUndefined();

      // The draft should still be published (blob error is non-fatal)
      const draft = await getDraft('at://did:plc:alice/app.bsky.feed.post/bloberr1');
      expect(draft?.status).toBe('published');
    });

    it('should call post-publish webhook when configured', async () => {
      const mockSession = { sub: 'did:plc:alice', serverMetadata: { issuer: 'https://pds.example.com' } };
      const mockCreateRecord = jest.fn().mockResolvedValue({ data: {} });
      getOAuthClient.mockReturnValue({ restore: jest.fn().mockResolvedValue(mockSession) });
      Agent.mockReturnValue({ com: { atproto: { repo: { createRecord: mockCreateRecord } } }, uploadBlob: jest.fn() });

      const mockFetch = jest.fn().mockResolvedValue({ ok: true });
      global.fetch = mockFetch;

      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/webhook1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'webhook1',
        record: { text: 'hook post' },
        recordCid: 'bafyhook',
        action: 'create',
      });

      const configWithWebhook = { ...config, postPublishWebhookUrl: 'https://hook.example.com/notify' };
      await publishDraft('at://did:plc:alice/app.bsky.feed.post/webhook1', configWithWebhook);

      expect(mockFetch).toHaveBeenCalledWith('https://hook.example.com/notify', expect.objectContaining({ method: 'POST' }));
    });

    it('should not throw when webhook fails', async () => {
      const mockSession = { sub: 'did:plc:alice', serverMetadata: { issuer: 'https://pds.example.com' } };
      const mockCreateRecord = jest.fn().mockResolvedValue({ data: {} });
      getOAuthClient.mockReturnValue({ restore: jest.fn().mockResolvedValue(mockSession) });
      Agent.mockReturnValue({ com: { atproto: { repo: { createRecord: mockCreateRecord } } }, uploadBlob: jest.fn() });

      global.fetch = jest.fn().mockRejectedValue(new Error('webhook down'));

      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/hookerr',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'hookerr',
        record: { text: 'hook fail' },
        recordCid: 'bafyhookerr',
        action: 'create',
      });

      const configWithWebhook = { ...config, postPublishWebhookUrl: 'https://hook.example.com/notify' };
      await expect(publishDraft('at://did:plc:alice/app.bsky.feed.post/hookerr', configWithWebhook)).resolves.toBeUndefined();
    });

    it('should skip draft with invalid AT-URI', async () => {
      // Manually insert a draft with a bad URI into the DB
      await db.insertInto('drafts').values({
        uri: 'not-a-valid-at-uri',
        user_did: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'bad',
        record: '{}',
        record_cid: null,
        action: 'create',
        status: 'draft',
        scheduled_at: null,
        created_at: Date.now(),
        updated_at: Date.now(),
        published_at: null,
        failure_reason: null,
      }).execute();

      // Status remains 'draft' so claimDraftForPublishing will succeed,
      // getDraft will return the row, then extractDidFromAtUri('not-a-valid-at-uri')
      // will throw, hitting the invalid AT-URI catch block (lines 78-79).
      await expect(publishDraft('not-a-valid-at-uri', config)).resolves.toBeUndefined();
    });

    it('should return early when getDraft returns null after a successful claim', async () => {
      // Create a real draft so claimDraftForPublishing can succeed
      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/gone1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'gone1',
        record: { text: 'vanished' },
        recordCid: 'bafygone',
        action: 'create',
      });

      // Spy on getDraft to return null for this specific call, simulating a
      // race where the draft row disappears between claim and fetch.
      const getDraftSpy = jest.spyOn(storage, 'getDraft').mockResolvedValueOnce(null);

      await expect(publishDraft('at://did:plc:alice/app.bsky.feed.post/gone1', config)).resolves.toBeUndefined();

      getDraftSpy.mockRestore();
    });

    it('should mark draft failed with no_oauth_authorization when user has no auth record', async () => {
      // Use a different DID that has no authorization
      await createDraft({
        uri: 'at://did:plc:noauth/app.bsky.feed.post/noauth1',
        userDid: 'did:plc:noauth',
        collection: 'app.bsky.feed.post',
        rkey: 'noauth1',
        record: { text: 'no auth' },
        recordCid: 'bafynoauth',
        action: 'create',
      });

      await publishDraft('at://did:plc:noauth/app.bsky.feed.post/noauth1', config);

      const draft = await getDraft('at://did:plc:noauth/app.bsky.feed.post/noauth1');
      expect(draft?.status).toBe('failed');
      expect(draft?.failureReason).toBe('no_oauth_authorization');
    });

    it('should re-throw non-revocation OAuth errors', async () => {
      getOAuthClient.mockReturnValue({
        restore: jest.fn().mockRejectedValue(new Error('network timeout')),
      });

      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/oautherr1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'oautherr1',
        record: { text: 'hello' },
        recordCid: 'bafyoautherr',
        action: 'create',
      });

      await publishDraft('at://did:plc:alice/app.bsky.feed.post/oautherr1', config);

      // Should end up retried (not oauth_revoked)
      const draft = await getDraft('at://did:plc:alice/app.bsky.feed.post/oautherr1');
      expect(draft?.failureReason).toBe('network timeout');
    });

    it('should mark as failed with oauth_revoked reason when OAuth is revoked', async () => {
      getOAuthClient.mockReturnValue({
        restore: jest.fn().mockRejectedValue(new Error('invalid_grant: token revoked')),
      });

      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/revoked1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'revoked1',
        record: { text: 'hello' },
        recordCid: 'bafyrevoked',
        action: 'create',
      });

      await publishDraft('at://did:plc:alice/app.bsky.feed.post/revoked1', config);

      const draft = await getDraft('at://did:plc:alice/app.bsky.feed.post/revoked1');
      expect(draft?.status).toBe('failed');
      expect(draft?.failureReason).toBe('oauth_revoked');
    });
  });

  describe('scheduler polling', () => {
    it('should pick up ready drafts on poll', async () => {
      const past = Date.now() - 1000;

      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/poll1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'poll1',
        record: { text: 'ready to publish' },
        recordCid: 'bafypoll',
        action: 'create',
        scheduledAt: past,
      });

      const ready = await getReadyDrafts();
      expect(ready).toHaveLength(1);
      expect(ready[0].uri).toBe('at://did:plc:alice/app.bsky.feed.post/poll1');
    });

    it('startScheduler and stopScheduler should not throw', () => {
      expect(() => startScheduler(config)).not.toThrow();
      expect(() => stopScheduler()).not.toThrow();
    });

    it('should not start scheduler twice', () => {
      startScheduler(config);
      // Second call should warn but not throw
      expect(() => startScheduler(config)).not.toThrow();
      stopScheduler();
    });

    it('should publish a past-due draft when poll fires', async () => {
      // Seed auth so the draft can be published
      await upsertUserAuthorization({
        userDid: 'did:plc:alice',
        pdsUrl: 'https://pds.example.com',
        refreshToken: 'encrypted-token',
        dpopPrivateKey: 'encrypted-key',
        tokenScope: 'atproto',
      });

      const mockSession = { sub: 'did:plc:alice', serverMetadata: { issuer: 'https://pds.example.com' } };
      const mockCreateRecord = jest.fn().mockResolvedValue({ data: {} });
      getOAuthClient.mockReturnValue({ restore: jest.fn().mockResolvedValue(mockSession) });
      Agent.mockReturnValue({ com: { atproto: { repo: { createRecord: mockCreateRecord } } } });

      const past = Date.now() - 1000;
      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/pollpub1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'pollpub1',
        record: { $type: 'app.bsky.feed.post', text: 'poll publish' },
        recordCid: 'bafypollpub',
        action: 'create',
        scheduledAt: past,
      });

      // Capture the setTimeout callback so we can fire it manually
      let timerCallback: (() => void) | undefined;
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((cb) => {
        timerCallback = cb as () => void;
        return { unref: jest.fn() } as unknown as ReturnType<typeof setTimeout>;
      });

      startScheduler(config);
      // Let scheduleNextWakeup's async DB query resolve and register the timer
      await flushPromises();
      await flushPromises();

      expect(timerCallback).toBeDefined();

      // Fire the timer callback to invoke poll()
      timerCallback!();

      // Allow poll() and publishDraft() to complete
      await flushPromises();
      await flushPromises();
      await flushPromises();

      setTimeoutSpy.mockRestore();

      const draft = await getDraft('at://did:plc:alice/app.bsky.feed.post/pollpub1');
      expect(draft?.status).toBe('published');
    });
  });

  // ---- Schedule chaining tests ----

  describe('schedule chaining (handleScheduleChaining)', () => {
    const DAILY_RULE = {
      rule: { type: 'daily', time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'UTC' } },
    };

    beforeEach(async () => {
      await upsertUserAuthorization({
        userDid: 'did:plc:alice',
        pdsUrl: 'https://pds.example.com',
        refreshToken: 'encrypted-token',
        dpopPrivateKey: 'encrypted-key',
        tokenScope: 'atproto',
      });
    });

    function mockOAuthAndAgent() {
      const mockCreateRecord = jest.fn().mockResolvedValue({ data: {} });
      getOAuthClient.mockReturnValue({
        restore: jest.fn().mockResolvedValue({
          sub: 'did:plc:alice',
          serverMetadata: { issuer: 'https://pds.example.com' },
        }),
      });
      Agent.mockReturnValue({
        com: { atproto: { repo: { createRecord: mockCreateRecord } } },
        uploadBlob: jest.fn(),
      });
      return mockCreateRecord;
    }

    it('creates next scheduled draft after publishing a schedule-linked draft', async () => {
      mockOAuthAndAgent();
      const scheduleId = 'sched-chain-1';
      await createSchedule({
        id: scheduleId,
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        record: { $type: 'app.bsky.feed.post', text: 'recurring' },
        contentUrl: null,
        recurrenceRule: DAILY_RULE,
        timezone: 'UTC',
      });

      const draftUri = 'at://did:plc:alice/app.bsky.feed.post/chain-draft-1';
      await createDraft({
        uri: draftUri,
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'chain-draft-1',
        record: { $type: 'app.bsky.feed.post', text: 'recurring' },
        recordCid: 'bafychain1',
        action: 'create',
        scheduledAt: Date.now() - 1000,
        scheduleId,
      });
      await updateScheduleNextDraft(scheduleId, draftUri);

      await publishDraft(draftUri, config);

      // Verify fire count incremented
      const schedule = await getRawSchedule(scheduleId);
      expect(schedule?.fire_count).toBe(1);
      expect(schedule?.last_fired_at).toBeDefined();

      // Verify a new next draft was created
      expect(schedule?.next_draft_uri).not.toBe(draftUri);
      expect(schedule?.next_draft_uri).toBeDefined();

      // Verify the new draft exists and is scheduled
      const nextDraft = await getDraft(schedule!.next_draft_uri!);
      expect(nextDraft?.status).toBe('scheduled');
      expect(nextDraft?.scheduleId).toBe(scheduleId);
    });

    it('does not chain when schedule status is not active (paused)', async () => {
      mockOAuthAndAgent();
      const scheduleId = 'sched-chain-paused';
      await createSchedule({
        id: scheduleId,
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        record: { $type: 'app.bsky.feed.post', text: 'paused' },
        contentUrl: null,
        recurrenceRule: DAILY_RULE,
        timezone: 'UTC',
      });

      // Manually pause the schedule
      await db
        .updateTable('schedules')
        .set({ status: 'paused' })
        .where('id', '=', scheduleId)
        .execute();

      const draftUri = 'at://did:plc:alice/app.bsky.feed.post/chain-paused-draft';
      await createDraft({
        uri: draftUri,
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'chain-paused-draft',
        record: { $type: 'app.bsky.feed.post', text: 'paused' },
        recordCid: 'bafychainpaused',
        action: 'create',
        scheduledAt: Date.now() - 1000,
        scheduleId,
      });

      await publishDraft(draftUri, config);

      const draft = await getDraft(draftUri);
      expect(draft?.status).toBe('published');

      const schedule = await getRawSchedule(scheduleId);
      // Fire count should NOT be incremented (schedule was paused)
      expect(schedule?.fire_count).toBe(0);
    });

    it('marks schedule cancelled when series is exhausted (no next occurrence)', async () => {
      mockOAuthAndAgent();
      const scheduleId = 'sched-chain-exhausted';
      // Use endDate in the past so computeNextOccurrence returns null
      const exhaustedRule = {
        rule: { type: 'daily', time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'UTC' } },
        endDate: '2020-01-01',
      };
      await createSchedule({
        id: scheduleId,
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        record: { $type: 'app.bsky.feed.post', text: 'exhausted' },
        contentUrl: null,
        recurrenceRule: exhaustedRule,
        timezone: 'UTC',
      });

      const draftUri = 'at://did:plc:alice/app.bsky.feed.post/chain-exhausted-draft';
      await createDraft({
        uri: draftUri,
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'chain-exhausted-draft',
        record: { $type: 'app.bsky.feed.post', text: 'exhausted' },
        recordCid: 'bafychainexhausted',
        action: 'create',
        scheduledAt: Date.now() - 1000,
        scheduleId,
      });

      await publishDraft(draftUri, config);

      const schedule = await getRawSchedule(scheduleId);
      expect(schedule?.status).toBe('cancelled');
      expect(schedule?.next_draft_uri).toBeNull();
    });

    it('marks schedule as error when recurrence rule JSON is invalid', async () => {
      mockOAuthAndAgent();
      const scheduleId = 'sched-chain-badrule';
      await createSchedule({
        id: scheduleId,
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        record: { $type: 'app.bsky.feed.post', text: 'bad rule' },
        contentUrl: null,
        recurrenceRule: DAILY_RULE,
        timezone: 'UTC',
      });

      // Corrupt the recurrence rule JSON directly in the DB
      await db
        .updateTable('schedules')
        .set({ recurrence_rule: 'not-valid-json{{{' })
        .where('id', '=', scheduleId)
        .execute();

      const draftUri = 'at://did:plc:alice/app.bsky.feed.post/chain-badrule-draft';
      await createDraft({
        uri: draftUri,
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'chain-badrule-draft',
        record: { $type: 'app.bsky.feed.post', text: 'bad rule' },
        recordCid: 'bafychainbadrule',
        action: 'create',
        scheduledAt: Date.now() - 1000,
        scheduleId,
      });

      await publishDraft(draftUri, config);

      const schedule = await getRawSchedule(scheduleId);
      expect(schedule?.status).toBe('error');
    });

    it('fetches content_url at publish time for dynamic schedules', async () => {
      const scheduleId = 'sched-dynamic-1';
      await createSchedule({
        id: scheduleId,
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        record: null,
        contentUrl: 'https://example.com/dynamic-content',
        recurrenceRule: DAILY_RULE,
        timezone: 'UTC',
      });

      const dynamicRecord = { $type: 'app.bsky.feed.post', text: 'dynamic content from url' };
      const mockCreateRecord = jest.fn().mockResolvedValue({ data: {} });
      getOAuthClient.mockReturnValue({
        restore: jest.fn().mockResolvedValue({
          sub: 'did:plc:alice',
          serverMetadata: { issuer: 'https://pds.example.com' },
        }),
      });
      Agent.mockReturnValue({
        com: { atproto: { repo: { createRecord: mockCreateRecord } } },
        uploadBlob: jest.fn(),
      });

      // Mock fetch to return dynamic record content
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(dynamicRecord),
      });

      const draftUri = 'at://did:plc:alice/app.bsky.feed.post/dynamic-draft-1';
      await createDraft({
        uri: draftUri,
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'dynamic-draft-1',
        record: null, // null record → dynamic schedule
        recordCid: null,
        action: 'create',
        scheduledAt: Date.now() - 1000,
        scheduleId,
      });

      await publishDraft(draftUri, config);

      expect(global.fetch).toHaveBeenCalled();
      const fetchedUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
      expect(fetchedUrl).toContain('https://example.com/dynamic-content');
      expect(fetchedUrl).toContain('fireCount=1');
      expect(fetchedUrl).toContain('scheduledAt=');

      // Draft should be published with the fetched content
      const draft = await getDraft(draftUri);
      expect(draft?.status).toBe('published');

      // The createRecord should have been called with the fetched record
      expect(mockCreateRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          record: expect.objectContaining({ text: 'dynamic content from url' }),
        }),
      );
    });

    it('marks draft and schedule as error when content_url fetch fails', async () => {
      const scheduleId = 'sched-dynamic-fail';
      await createSchedule({
        id: scheduleId,
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        record: null,
        contentUrl: 'https://example.com/failing-content',
        recurrenceRule: DAILY_RULE,
        timezone: 'UTC',
      });

      getOAuthClient.mockReturnValue({
        restore: jest.fn().mockResolvedValue({
          sub: 'did:plc:alice',
          serverMetadata: { issuer: 'https://pds.example.com' },
        }),
      });
      Agent.mockReturnValue({
        com: { atproto: { repo: { createRecord: jest.fn() } } },
        uploadBlob: jest.fn(),
      });

      // Mock fetch to simulate HTTP error
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
      });

      const draftUri = 'at://did:plc:alice/app.bsky.feed.post/dynamic-fail-draft';
      await createDraft({
        uri: draftUri,
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'dynamic-fail-draft',
        record: null,
        recordCid: null,
        action: 'create',
        scheduledAt: Date.now() - 1000,
        scheduleId,
      });

      await publishDraft(draftUri, config);

      const draft = await getDraft(draftUri);
      expect(draft?.status).toBe('failed');
      expect(draft?.failureReason).toContain('content_url_fetch_failed');

      const schedule = await getRawSchedule(scheduleId);
      expect(schedule?.status).toBe('error');
    });

    it('marks draft failed when dynamic schedule has no content_url', async () => {
      const scheduleId = 'sched-dynamic-nocontent';
      await createSchedule({
        id: scheduleId,
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        record: null,
        contentUrl: null,  // no content URL set
        recurrenceRule: DAILY_RULE,
        timezone: 'UTC',
      });

      getOAuthClient.mockReturnValue({
        restore: jest.fn().mockResolvedValue({
          sub: 'did:plc:alice',
          serverMetadata: { issuer: 'https://pds.example.com' },
        }),
      });
      Agent.mockReturnValue({
        com: { atproto: { repo: { createRecord: jest.fn() } } },
      });

      const draftUri = 'at://did:plc:alice/app.bsky.feed.post/dynamic-nocontent-draft';
      await createDraft({
        uri: draftUri,
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'dynamic-nocontent-draft',
        record: null,  // null record triggers dynamic schedule path
        recordCid: null,
        action: 'create',
        scheduledAt: Date.now() - 1000,
        scheduleId,
      });

      await publishDraft(draftUri, config);

      const draft = await getDraft(draftUri);
      expect(draft?.status).toBe('failed');
      expect(draft?.failureReason).toBe('dynamic_schedule_missing_content_url');
    });

    it('marks schedule as error when createDraft throws during next draft creation', async () => {
      mockOAuthAndAgent();
      const scheduleId = 'sched-chain-createfail';
      await createSchedule({
        id: scheduleId,
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        record: { $type: 'app.bsky.feed.post', text: 'recurring' },
        contentUrl: null,
        recurrenceRule: DAILY_RULE,
        timezone: 'UTC',
      });

      const draftUri = 'at://did:plc:alice/app.bsky.feed.post/chain-createfail-1';
      await createDraft({
        uri: draftUri,
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'chain-createfail-1',
        record: { $type: 'app.bsky.feed.post', text: 'recurring' },
        recordCid: 'bafychain-cf',
        action: 'create',
        scheduledAt: Date.now() - 1000,
        scheduleId,
      });
      await updateScheduleNextDraft(scheduleId, draftUri);

      // Make createDraft fail on the next call (for creating the chained next draft)
      const spy = jest.spyOn(storage, 'createDraft').mockRejectedValueOnce(new Error('DB constraint'));

      await publishDraft(draftUri, config);

      spy.mockRestore();

      const schedule = await getRawSchedule(scheduleId);
      expect(schedule?.status).toBe('error');
    });

    it('catches errors thrown by handleScheduleChaining itself (non-fatal chain error path)', async () => {
      mockOAuthAndAgent();
      const scheduleId = 'sched-chain-throw';
      await createSchedule({
        id: scheduleId,
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        record: { $type: 'app.bsky.feed.post', text: 'recurring' },
        contentUrl: null,
        recurrenceRule: DAILY_RULE,
        timezone: 'UTC',
      });

      const draftUri = 'at://did:plc:alice/app.bsky.feed.post/chain-throw-1';
      await createDraft({
        uri: draftUri,
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'chain-throw-1',
        record: { $type: 'app.bsky.feed.post', text: 'recurring' },
        recordCid: 'bafychain-throw',
        action: 'create',
        scheduledAt: Date.now() - 1000,
        scheduleId,
      });
      await updateScheduleNextDraft(scheduleId, draftUri);

      // Make incrementScheduleFireCount throw — handleScheduleChaining has no try/catch around it,
      // so this propagates to the outer catch in publishDraft (line 302)
      const spy = jest.spyOn(storage, 'incrementScheduleFireCount').mockRejectedValueOnce(new Error('Unexpected DB error'));

      // publishDraft should NOT throw — the error is caught and logged non-fatally
      await expect(publishDraft(draftUri, config)).resolves.toBeUndefined();

      spy.mockRestore();

      // The draft itself should still be published (chaining error is non-fatal)
      const draft = await getDraft(draftUri);
      expect(draft?.status).toBe('published');
    });
  });

  describe('poll error handling', () => {
    it('should not throw when getReadyDrafts fails during a poll', async () => {
      // Seed auth so scheduleNextWakeup has a past-due draft to schedule against
      await upsertUserAuthorization({
        userDid: 'did:plc:alice',
        pdsUrl: 'https://pds.example.com',
        refreshToken: 'encrypted-token',
        dpopPrivateKey: 'encrypted-key',
        tokenScope: 'atproto',
      });

      const past = Date.now() - 1000;
      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/pollerr1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'pollerr1',
        record: { text: 'poll error' },
        recordCid: 'bafypollerr',
        action: 'create',
        scheduledAt: past,
      });

      // Make getReadyDrafts throw so we hit the error branch inside poll()
      const spy = jest.spyOn(storage, 'getReadyDrafts').mockRejectedValueOnce(new Error('DB gone'));

      let timerCallback: (() => void) | undefined;
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((cb) => {
        timerCallback = cb as () => void;
        return { unref: jest.fn() } as unknown as ReturnType<typeof setTimeout>;
      });

      startScheduler(config);
      await flushPromises();
      await flushPromises();

      expect(timerCallback).toBeDefined();

      // Fire poll — getReadyDrafts will throw, but poll must not propagate
      expect(() => timerCallback!()).not.toThrow();
      await flushPromises();

      setTimeoutSpy.mockRestore();
      spy.mockRestore();
    });
  });

  describe('event-driven wakeup', () => {
    it('should set a timeout with correct delay for a future scheduled draft', async () => {
      const futureTime = Date.now() + 5000;
      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/future1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'future1',
        record: { text: 'future post' },
        recordCid: 'bafyfuture',
        action: 'create',
        scheduledAt: futureTime,
      });

      const mockTimer = { unref: jest.fn() } as unknown as ReturnType<typeof setTimeout>;
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockReturnValue(mockTimer);

      startScheduler(config);
      await flushPromises();

      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      const delay = setTimeoutSpy.mock.calls[0][1] as number;
      expect(delay).toBeGreaterThanOrEqual(4900);
      expect(delay).toBeLessThanOrEqual(5100);

      setTimeoutSpy.mockRestore();
    });

    it('should not set a timeout when there are no scheduled drafts', async () => {
      const mockTimer = { unref: jest.fn() } as unknown as ReturnType<typeof setTimeout>;
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockReturnValue(mockTimer);

      startScheduler(config);
      await flushPromises();

      expect(setTimeoutSpy).not.toHaveBeenCalled();

      setTimeoutSpy.mockRestore();
    });

    it('notifyScheduler should cancel an existing timeout and recalculate', async () => {
      // Create a far-future draft so the first wakeup is far out
      const farFuture = Date.now() + 60000;
      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/farfuture1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'farfuture1',
        record: { text: 'far future' },
        recordCid: 'bafyfar',
        action: 'create',
        scheduledAt: farFuture,
      });

      const timer1 = { unref: jest.fn() } as unknown as ReturnType<typeof setTimeout>;
      const timer2 = { unref: jest.fn() } as unknown as ReturnType<typeof setTimeout>;
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout')
        .mockReturnValueOnce(timer1)
        .mockReturnValueOnce(timer2);
      const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

      startScheduler(config);
      await flushPromises();

      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

      // Reschedule the draft to be near-future
      const nearFuture = Date.now() + 1000;
      await db
        .updateTable('drafts')
        .set({ scheduled_at: nearFuture })
        .where('uri', '=', 'at://did:plc:alice/app.bsky.feed.post/farfuture1')
        .execute();

      notifyScheduler();
      await flushPromises();

      // Old timer was cancelled and a new one was set with a smaller delay
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timer1);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
      const secondDelay = setTimeoutSpy.mock.calls[1][1] as number;
      expect(secondDelay).toBeLessThan(2000);

      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    });

    it('handles superseded wakeup generation gracefully with no scheduled drafts (notifyScheduler noop)', async () => {
      // When stopScheduler is called, scheduleNextWakeup returns early
      // This test just verifies notifyScheduler doesn't throw when scheduler is stopped
      stopScheduler();
      notifyScheduler();
      // No assertions needed — just verifying no throws
    });

    it('handles superseded wakeup generation gracefully', async () => {
      const futureTime = Date.now() + 5000;
      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/sup1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'sup1',
        record: { text: 'superseded wakeup' },
        recordCid: 'bafysup',
        action: 'create',
        scheduledAt: futureTime,
      });

      let timerCount = 0;
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(() => {
        timerCount++;
        return { unref: jest.fn() } as unknown as ReturnType<typeof setTimeout>;
      });

      // startScheduler calls scheduleNextWakeup() which suspends at the DB await.
      // notifyScheduler() immediately calls scheduleNextWakeup() again, incrementing
      // scheduleGeneration before the first call's DB query resolves.
      // When both resolve: call 1 sees myGen !== scheduleGeneration and returns early
      // without setting a timer; call 2 sees myGen === scheduleGeneration and sets one timer.
      startScheduler(config);
      notifyScheduler();

      await flushPromises();
      await flushPromises();

      // Only the non-superseded (second) call should have set a timer
      expect(timerCount).toBe(1);

      setTimeoutSpy.mockRestore();
    });
  });
});
