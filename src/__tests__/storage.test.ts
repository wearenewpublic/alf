// Tests for draft storage operations with in-memory SQLite

import { Kysely } from 'kysely';
import type { ServiceConfig } from '../config';
import { createDb, initializeSchema } from '../database';
import {
  setDb,
  createDraft,
  getDraft,
  listDrafts,
  scheduleDraft,
  updateDraft,
  cancelDraft,
  claimDraftForPublishing,
  markDraftPublished,
  markDraftFailed,
  incrementRetryCount,
  getReadyDrafts,
  countActiveDraftsForUser,
  upsertUserAuthorization,
  getUserAuthorization,
  deleteUserData,
  saveOAuthState,
  getOAuthState,
  deleteOAuthState,
  storeDraftBlob,
  getBlobsByCids,
  deleteBlobs,
  cleanExpiredOAuthStates,
} from '../storage';
import type { Database } from '../schema';

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

describe('storage', () => {
  let db: Kysely<Database>;
  const config = createMockConfig();

  beforeEach(async () => {
    db = createDb(config);
    await initializeSchema(db, config);
    setDb(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  // ---- Draft CRUD ----

  describe('createDraft', () => {
    it('should create a draft with status draft when no scheduledAt', async () => {
      const draft = await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/abc123',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'abc123',
        record: { $type: 'app.bsky.feed.post', text: 'hello' },
        recordCid: 'bafyabc123',
        action: 'create',
      });

      expect(draft.status).toBe('draft');
      expect(draft.uri).toBe('at://did:plc:alice/app.bsky.feed.post/abc123');
      expect(draft.cid).toBe('bafyabc123');
      expect(draft.action).toBe('create');
      expect(draft.scheduledAt).toBeUndefined();
    });

    it('should create a draft with status scheduled when scheduledAt is provided', async () => {
      const scheduledAt = Date.now() + 60_000;
      const draft = await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/sched1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'sched1',
        record: { $type: 'app.bsky.feed.post', text: 'scheduled' },
        recordCid: 'bafysched',
        action: 'create',
        scheduledAt,
      });

      expect(draft.status).toBe('scheduled');
      expect(draft.scheduledAt).toBeDefined();
    });

    it('should create a delete draft with null record and cid', async () => {
      const draft = await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/del1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'del1',
        record: null,
        recordCid: null,
        action: 'delete',
      });

      expect(draft.action).toBe('delete');
      expect(draft.cid).toBeUndefined();
    });
  });

  describe('getDraft', () => {
    it('should return null for non-existent draft', async () => {
      const result = await getDraft('at://did:plc:nobody/app/xyz');
      expect(result).toBeNull();
    });

    it('should return draft after creation', async () => {
      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/get1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'get1',
        record: { text: 'hello' },
        recordCid: 'bafyget1',
        action: 'create',
      });

      const result = await getDraft('at://did:plc:alice/app.bsky.feed.post/get1');
      expect(result).not.toBeNull();
      expect(result?.status).toBe('draft');
    });
  });

  describe('listDrafts', () => {
    beforeEach(async () => {
      for (let i = 0; i < 3; i++) {
        await createDraft({
          uri: `at://did:plc:alice/app.bsky.feed.post/list${i}`,
          userDid: 'did:plc:alice',
          collection: 'app.bsky.feed.post',
          rkey: `list${i}`,
          record: { text: `post ${i}` },
          recordCid: `bafylist${i}`,
          action: 'create',
        });
      }
    });

    it('should list all drafts for a user', async () => {
      const result = await listDrafts({ userDid: 'did:plc:alice', limit: 50 });
      expect(result.drafts).toHaveLength(3);
    });

    it('should filter by status', async () => {
      const scheduledAt = Date.now() + 60_000;
      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/sched',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'sched',
        record: { text: 'scheduled' },
        recordCid: 'bafysched',
        action: 'create',
        scheduledAt,
      });

      const result = await listDrafts({ userDid: 'did:plc:alice', status: 'scheduled', limit: 50 });
      expect(result.drafts).toHaveLength(1);
      expect(result.drafts[0].status).toBe('scheduled');
    });

    it('should paginate with limit', async () => {
      const result = await listDrafts({ userDid: 'did:plc:alice', limit: 2 });
      expect(result.drafts).toHaveLength(2);
      expect(result.cursor).toBeDefined();
    });

    it('should not return drafts for other users', async () => {
      const result = await listDrafts({ userDid: 'did:plc:bob', limit: 50 });
      expect(result.drafts).toHaveLength(0);
    });
  });

  describe('scheduleDraft', () => {
    it('should set status to scheduled', async () => {
      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/s1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 's1',
        record: { text: 'hello' },
        recordCid: 'bafys1',
        action: 'create',
      });

      const publishAt = Date.now() + 60_000;
      const draft = await scheduleDraft('at://did:plc:alice/app.bsky.feed.post/s1', publishAt);

      expect(draft?.status).toBe('scheduled');
      expect(draft?.scheduledAt).toBeDefined();
    });

    it('should return null for non-existent draft', async () => {
      const result = await scheduleDraft('at://nonexistent', Date.now() + 60_000);
      expect(result).toBeNull();
    });
  });

  describe('updateDraft', () => {
    beforeEach(async () => {
      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/upd1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'upd1',
        record: { text: 'original' },
        recordCid: 'bafyoriginal',
        action: 'create',
      });
    });

    it('should update record content and CID', async () => {
      const draft = await updateDraft('at://did:plc:alice/app.bsky.feed.post/upd1', {
        record: { text: 'updated' },
        recordCid: 'bafyupdated',
      });

      expect(draft?.cid).toBe('bafyupdated');
    });

    it('should update scheduled time', async () => {
      const newTime = Date.now() + 120_000;
      const draft = await updateDraft('at://did:plc:alice/app.bsky.feed.post/upd1', {
        scheduledAt: newTime,
      });

      expect(draft?.status).toBe('scheduled');
      expect(draft?.scheduledAt).toBeDefined();
    });

    it('should return null for non-existent draft', async () => {
      const result = await updateDraft('at://nonexistent', { record: { text: 'x' } });
      expect(result).toBeNull();
    });
  });

  describe('cancelDraft', () => {
    it('should set status to cancelled', async () => {
      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/cancel1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'cancel1',
        record: { text: 'to cancel' },
        recordCid: 'bafycancel',
        action: 'create',
      });

      await cancelDraft('at://did:plc:alice/app.bsky.feed.post/cancel1');

      const draft = await getDraft('at://did:plc:alice/app.bsky.feed.post/cancel1');
      expect(draft?.status).toBe('cancelled');
    });
  });

  // ---- Publishing State Transitions ----

  describe('claimDraftForPublishing', () => {
    it('should atomically claim a draft and return true', async () => {
      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/claim1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'claim1',
        record: { text: 'hello' },
        recordCid: 'bafyclaim',
        action: 'create',
      });

      const result = await claimDraftForPublishing('at://did:plc:alice/app.bsky.feed.post/claim1');
      expect(result).toBe(true);

      const draft = await getDraft('at://did:plc:alice/app.bsky.feed.post/claim1');
      expect(draft?.status).toBe('publishing');
    });

    it('should return false if already claimed', async () => {
      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/claim2',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'claim2',
        record: { text: 'hello' },
        recordCid: 'bafyclaim2',
        action: 'create',
      });

      await claimDraftForPublishing('at://did:plc:alice/app.bsky.feed.post/claim2');
      const result = await claimDraftForPublishing('at://did:plc:alice/app.bsky.feed.post/claim2');
      expect(result).toBe(false);
    });
  });

  describe('markDraftPublished', () => {
    it('should set status to published', async () => {
      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/pub1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'pub1',
        record: { text: 'hello' },
        recordCid: 'bafypub',
        action: 'create',
      });

      await markDraftPublished('at://did:plc:alice/app.bsky.feed.post/pub1');

      const draft = await getDraft('at://did:plc:alice/app.bsky.feed.post/pub1');
      expect(draft?.status).toBe('published');
    });
  });

  describe('markDraftFailed', () => {
    it('should set status to failed with reason', async () => {
      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/fail1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'fail1',
        record: { text: 'hello' },
        recordCid: 'bafyfail',
        action: 'create',
      });

      await markDraftFailed('at://did:plc:alice/app.bsky.feed.post/fail1', 'network error', false);

      const draft = await getDraft('at://did:plc:alice/app.bsky.feed.post/fail1');
      expect(draft?.status).toBe('failed');
      expect(draft?.failureReason).toBe('network error');
    });

    it('should reset to scheduled with backoff when resetToScheduled=true', async () => {
      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/retry1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'retry1',
        record: { text: 'hello' },
        recordCid: 'bafyretry',
        action: 'create',
      });

      const retryAt = Date.now() + 60_000;
      await markDraftFailed('at://did:plc:alice/app.bsky.feed.post/retry1', 'transient error', true, retryAt);

      const draft = await getDraft('at://did:plc:alice/app.bsky.feed.post/retry1');
      expect(draft?.status).toBe('scheduled');
      expect(draft?.failureReason).toBe('transient error');
    });
  });

  describe('incrementRetryCount', () => {
    it('should increment the retry count', async () => {
      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/rc1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'rc1',
        record: { text: 'hello' },
        recordCid: 'bafyrc',
        action: 'create',
      });

      const count1 = await incrementRetryCount('at://did:plc:alice/app.bsky.feed.post/rc1');
      expect(count1).toBe(1);

      const count2 = await incrementRetryCount('at://did:plc:alice/app.bsky.feed.post/rc1');
      expect(count2).toBe(2);
    });
  });

  describe('getReadyDrafts', () => {
    it('should return drafts with scheduled_at <= now', async () => {
      const past = Date.now() - 1000;
      const future = Date.now() + 60_000;

      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/ready1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'ready1',
        record: { text: 'ready' },
        recordCid: 'bafyready',
        action: 'create',
        scheduledAt: past,
      });

      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/notready1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'notready1',
        record: { text: 'not ready' },
        recordCid: 'bafynotready',
        action: 'create',
        scheduledAt: future,
      });

      const ready = await getReadyDrafts();
      expect(ready).toHaveLength(1);
      expect(ready[0].uri).toBe('at://did:plc:alice/app.bsky.feed.post/ready1');
    });

    it('should not return drafts with status other than scheduled', async () => {
      const past = Date.now() - 1000;
      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/rdraft1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'rdraft1',
        record: { text: 'draft' },
        recordCid: 'bafydraft',
        action: 'create',
        // No scheduledAt - status will be 'draft'
      });

      // Manually set scheduled_at to past but keep status as 'draft'
      await db
        .updateTable('drafts')
        .set({ scheduled_at: past })
        .where('uri', '=', 'at://did:plc:alice/app.bsky.feed.post/rdraft1')
        .execute();

      const ready = await getReadyDrafts();
      expect(ready.every((d) => d.status === 'scheduled')).toBe(true);
    });
  });

  // ---- countActiveDraftsForUser ----

  describe('countActiveDraftsForUser', () => {
    it('returns 0 when the user has no drafts', async () => {
      const count = await countActiveDraftsForUser('did:plc:nobody');
      expect(count).toBe(0);
    });

    it('counts draft and scheduled drafts as active', async () => {
      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/cnt1',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'cnt1',
        record: { text: 'a' },
        recordCid: 'bafycnt1',
        action: 'create',
      });
      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/cnt2',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'cnt2',
        record: { text: 'b' },
        recordCid: 'bafycnt2',
        action: 'create',
        scheduledAt: Date.now() + 60_000,
      });
      const count = await countActiveDraftsForUser('did:plc:alice');
      expect(count).toBe(2);
    });

    it('does not count published, failed, or cancelled drafts', async () => {
      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/pub',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'pub',
        record: { text: 'pub' },
        recordCid: 'bafypub',
        action: 'create',
      });
      await markDraftPublished('at://did:plc:alice/app.bsky.feed.post/pub');

      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/fail',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'fail',
        record: { text: 'fail' },
        recordCid: 'bafyfail2',
        action: 'create',
      });
      await markDraftFailed('at://did:plc:alice/app.bsky.feed.post/fail', 'err', false);

      await createDraft({
        uri: 'at://did:plc:alice/app.bsky.feed.post/canc',
        userDid: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'canc',
        record: { text: 'canc' },
        recordCid: 'bafycanc',
        action: 'create',
      });
      await cancelDraft('at://did:plc:alice/app.bsky.feed.post/canc');

      const count = await countActiveDraftsForUser('did:plc:alice');
      expect(count).toBe(0);
    });

    it('does not count drafts belonging to other users', async () => {
      await createDraft({
        uri: 'at://did:plc:bob/app.bsky.feed.post/bobdraft',
        userDid: 'did:plc:bob',
        collection: 'app.bsky.feed.post',
        rkey: 'bobdraft',
        record: { text: 'bob' },
        recordCid: 'bafybob',
        action: 'create',
      });
      const count = await countActiveDraftsForUser('did:plc:alice');
      expect(count).toBe(0);
    });
  });

  // ---- User Authorization ----

  describe('upsertUserAuthorization', () => {
    it('should insert a new authorization', async () => {
      await upsertUserAuthorization({
        userDid: 'did:plc:testuser',
        pdsUrl: 'https://pds.example.com',
        refreshToken: 'encrypted-token',
        dpopPrivateKey: 'encrypted-key',
        tokenScope: 'atproto',
      });

      const row = await getUserAuthorization('did:plc:testuser');
      expect(row).not.toBeUndefined();
      expect(row?.pds_url).toBe('https://pds.example.com');
      expect(row?.refresh_token).toBe('encrypted-token');
    });

    it('should update an existing authorization', async () => {
      await upsertUserAuthorization({
        userDid: 'did:plc:testuser2',
        pdsUrl: 'https://pds.example.com',
        refreshToken: 'old-token',
        dpopPrivateKey: 'old-key',
        tokenScope: 'atproto',
      });

      await upsertUserAuthorization({
        userDid: 'did:plc:testuser2',
        pdsUrl: 'https://pds2.example.com',
        refreshToken: 'new-token',
        dpopPrivateKey: 'new-key',
        tokenScope: 'atproto transition:generic',
      });

      const row = await getUserAuthorization('did:plc:testuser2');
      expect(row?.refresh_token).toBe('new-token');
      expect(row?.pds_url).toBe('https://pds2.example.com');
    });
  });

  // ---- deleteUserData ----

  describe('deleteUserData', () => {
    it('cancels active drafts and removes authorization', async () => {
      await upsertUserAuthorization({
        userDid: 'did:plc:del',
        pdsUrl: 'https://pds.example.com',
        refreshToken: 'tok',
        dpopPrivateKey: 'key',
        tokenScope: 'atproto',
      });
      await createDraft({
        uri: 'at://did:plc:del/app.bsky.feed.post/d1',
        userDid: 'did:plc:del',
        collection: 'app.bsky.feed.post',
        rkey: 'd1',
        record: { text: 'hi' },
        recordCid: 'bafydel1',
        action: 'create',
      });
      await createDraft({
        uri: 'at://did:plc:del/app.bsky.feed.post/d2',
        userDid: 'did:plc:del',
        collection: 'app.bsky.feed.post',
        rkey: 'd2',
        record: { text: 'hi' },
        recordCid: 'bafydel2',
        action: 'create',
        scheduledAt: Date.now() + 60_000,
      });

      await deleteUserData('did:plc:del');

      const d1 = await getDraft('at://did:plc:del/app.bsky.feed.post/d1');
      const d2 = await getDraft('at://did:plc:del/app.bsky.feed.post/d2');
      expect(d1?.status).toBe('cancelled');
      expect(d2?.status).toBe('cancelled');
      expect(await getUserAuthorization('did:plc:del')).toBeUndefined();
    });

    it('does not affect other users', async () => {
      await upsertUserAuthorization({
        userDid: 'did:plc:other',
        pdsUrl: 'https://pds.example.com',
        refreshToken: 'tok',
        dpopPrivateKey: 'key',
        tokenScope: 'atproto',
      });
      await deleteUserData('did:plc:nobody');
      expect(await getUserAuthorization('did:plc:other')).not.toBeUndefined();
    });
  });

  // ---- OAuth States ----

  describe('OAuth states', () => {
    it('should save and retrieve a state', async () => {
      const stateData = { codeVerifier: 'abc', handle: 'alice.test' };
      await saveOAuthState('state-key-1', stateData);

      const result = await getOAuthState('state-key-1');
      expect(result).toEqual(stateData);
    });

    it('should return null for expired state', async () => {
      // Insert directly with past expiry
      await db
        .insertInto('oauth_states')
        .values({
          state_key: 'expired-state',
          state_data: JSON.stringify({ test: true }),
          expires_at: Date.now() - 1000,
          created_at: Date.now() - 700_000,
        })
        .execute();

      const result = await getOAuthState('expired-state');
      expect(result).toBeNull();
    });

    it('should delete a state', async () => {
      await saveOAuthState('del-state', { test: true });
      await deleteOAuthState('del-state');

      const result = await getOAuthState('del-state');
      expect(result).toBeNull();
    });

    it('should return null for non-existent state', async () => {
      const result = await getOAuthState('nonexistent-state');
      expect(result).toBeNull();
    });
  });

  // ---- Blob operations ----

  describe('storeDraftBlob / getBlobsByCids / deleteBlobs', () => {
    const userDid = 'did:plc:blobuser';
    const cid = 'bafyblobcid123';
    const data = Buffer.from('fake image bytes');
    const mimeType = 'image/png';

    it('stores a blob and retrieves it by CID', async () => {
      await storeDraftBlob(userDid, cid, data, mimeType, data.length);
      const blobs = await getBlobsByCids(userDid, [cid]);
      expect(blobs).toHaveLength(1);
      expect(blobs[0].cid).toBe(cid);
      expect(blobs[0].mimeType).toBe(mimeType);
      expect(Buffer.from(blobs[0].data).toString()).toBe('fake image bytes');
    });

    it('returns empty array when cids list is empty', async () => {
      const blobs = await getBlobsByCids(userDid, []);
      expect(blobs).toHaveLength(0);
    });

    it('ignores a duplicate store for the same user+cid (DO NOTHING, content-addressed)', async () => {
      await storeDraftBlob(userDid, cid, data, mimeType, data.length);
      // Storing the same CID again is a no-op; original row is preserved
      const duplicate = Buffer.from('different bytes same cid');
      await storeDraftBlob(userDid, cid, duplicate, 'image/jpeg', duplicate.length);
      const blobs = await getBlobsByCids(userDid, [cid]);
      expect(blobs).toHaveLength(1);
      expect(Buffer.from(blobs[0].data).toString()).toBe('fake image bytes');
    });

    it('does not return blobs for a different user', async () => {
      await storeDraftBlob(userDid, cid, data, mimeType, data.length);
      const blobs = await getBlobsByCids('did:plc:otheruser', [cid]);
      expect(blobs).toHaveLength(0);
    });

    it('deletes blobs by cid', async () => {
      await storeDraftBlob(userDid, cid, data, mimeType, data.length);
      await deleteBlobs([cid]);
      const blobs = await getBlobsByCids(userDid, [cid]);
      expect(blobs).toHaveLength(0);
    });

    it('deleteBlobs is a no-op for empty cids list', async () => {
      await expect(deleteBlobs([])).resolves.toBeUndefined();
    });
  });

  // ---- cleanExpiredOAuthStates ----

  describe('cleanExpiredOAuthStates', () => {
    it('deletes expired states and leaves valid ones', async () => {
      await db
        .insertInto('oauth_states')
        .values({
          state_key: 'expired-clean',
          state_data: JSON.stringify({ x: 1 }),
          expires_at: Date.now() - 1000,
          created_at: Date.now() - 700_000,
        })
        .execute();
      await saveOAuthState('valid-clean', { x: 2 });

      await cleanExpiredOAuthStates();

      expect(await getOAuthState('expired-clean')).toBeNull();
      expect(await getOAuthState('valid-clean')).toEqual({ x: 2 });
    });
  });

  // ---- createDraft re-use after terminal status ----

  describe('createDraft URI re-use', () => {
    const uri = 'at://did:plc:alice/app.bsky.feed.post/reuse1';

    it('allows re-creating a draft after the previous one is published', async () => {
      await createDraft({ uri, userDid: 'did:plc:alice', collection: 'app.bsky.feed.post', rkey: 'reuse1', record: { text: 'v1' }, recordCid: 'bafy1', action: 'create' });
      await markDraftPublished(uri);

      // Should not throw — previous draft was published
      const d2 = await createDraft({ uri, userDid: 'did:plc:alice', collection: 'app.bsky.feed.post', rkey: 'reuse1', record: { text: 'v2' }, recordCid: 'bafy2', action: 'create' });
      expect(d2.status).toBe('draft');
    });

    it('throws DuplicateDraft when an active draft exists', async () => {
      await createDraft({ uri: 'at://did:plc:alice/app.bsky.feed.post/dup', userDid: 'did:plc:alice', collection: 'app.bsky.feed.post', rkey: 'dup', record: { text: 'x' }, recordCid: 'bafydup', action: 'create' });

      await expect(
        createDraft({ uri: 'at://did:plc:alice/app.bsky.feed.post/dup', userDid: 'did:plc:alice', collection: 'app.bsky.feed.post', rkey: 'dup', record: { text: 'x2' }, recordCid: 'bafydup2', action: 'create' }),
      ).rejects.toMatchObject({ code: 'DuplicateDraft' });
    });
  });

  // ---- listDrafts cursor with non-scheduled status ----

  describe('listDrafts cursor with non-scheduled status', () => {
    it('exercises created_at < cursor path for non-scheduled status', async () => {
      // Use a future cursor to exercise line 126 (created_at < cursorTime)
      // for non-scheduled status (status != 'scheduled')
      const result = await listDrafts({
        userDid: 'did:plc:alice',
        status: 'draft',
        cursor: String(Date.now() + 1_000_000),
        limit: 10,
      });
      expect(result).toBeDefined();
    });
  });

  // ---- listDrafts cursor with scheduled status ----

  describe('listDrafts cursor with status=scheduled', () => {
    it('paginates scheduled drafts by scheduled_at', async () => {
      const base = Date.now();
      for (let i = 0; i < 3; i++) {
        await createDraft({
          uri: `at://did:plc:alice/app.bsky.feed.post/scpg${i}`,
          userDid: 'did:plc:alice',
          collection: 'app.bsky.feed.post',
          rkey: `scpg${i}`,
          record: { text: `post ${i}` },
          recordCid: `bafyscpg${i}`,
          action: 'create',
          scheduledAt: base + i * 1000,
        });
      }

      const page1 = await listDrafts({ userDid: 'did:plc:alice', status: 'scheduled', limit: 2 });
      expect(page1.drafts).toHaveLength(2);
      expect(page1.cursor).toBeDefined();

      const page2 = await listDrafts({ userDid: 'did:plc:alice', status: 'scheduled', limit: 2, cursor: page1.cursor });
      expect(page2.drafts.length).toBeGreaterThanOrEqual(1);
    });
  });
});
