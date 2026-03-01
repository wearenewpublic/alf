// Tests for schema utility functions

import { rowToDraftView, extractDidFromAtUri, rowToScheduleView } from '../schema';
import type { DraftRow, ScheduleRow } from '../schema';

describe('rowToDraftView', () => {
  const baseRow = (): DraftRow => ({
    uri: 'at://did:plc:alice/app.bsky.feed.post/abc',
    user_did: 'did:plc:alice',
    collection: 'app.bsky.feed.post',
    rkey: 'abc',
    record: JSON.stringify({ $type: 'app.bsky.feed.post', text: 'hello' }),
    record_cid: 'bafytest',
    action: 'create',
    status: 'draft',
    scheduled_at: null,
    retry_count: 0,
    created_at: 1700000000000,
    updated_at: 1700000000000,
    published_at: null,
    failure_reason: null,
    trigger_key_hash: null,
    trigger_key_encrypted: null,
    schedule_id: null,
  });

  it('maps required fields', () => {
    const view = rowToDraftView(baseRow());
    expect(view.uri).toBe('at://did:plc:alice/app.bsky.feed.post/abc');
    expect(view.collection).toBe('app.bsky.feed.post');
    expect(view.rkey).toBe('abc');
    expect(view.action).toBe('create');
    expect(view.status).toBe('draft');
    expect(view.cid).toBe('bafytest');
  });

  it('omits cid when record_cid is null', () => {
    const row = { ...baseRow(), record_cid: null };
    expect(rowToDraftView(row).cid).toBeUndefined();
  });

  it('includes scheduledAt when scheduled_at is set', () => {
    const row = { ...baseRow(), scheduled_at: 1700001000000 };
    const view = rowToDraftView(row);
    expect(view.scheduledAt).toBe(new Date(1700001000000).toISOString());
  });

  it('omits scheduledAt when scheduled_at is null', () => {
    expect(rowToDraftView(baseRow()).scheduledAt).toBeUndefined();
  });

  it('parses record JSON', () => {
    const view = rowToDraftView(baseRow());
    expect(view.record).toEqual({ $type: 'app.bsky.feed.post', text: 'hello' });
  });

  it('omits record when record is null', () => {
    const row = { ...baseRow(), record: null };
    expect(rowToDraftView(row).record).toBeUndefined();
  });

  it('includes failureReason when set', () => {
    const row = { ...baseRow(), failure_reason: 'network error' };
    expect(rowToDraftView(row).failureReason).toBe('network error');
  });
});

describe('rowToScheduleView', () => {
  const baseScheduleRow = (): ScheduleRow => ({
    id: 'sched-uuid-1',
    user_did: 'did:plc:alice',
    collection: 'app.bsky.feed.post',
    record: JSON.stringify({ $type: 'app.bsky.feed.post', text: 'scheduled post' }),
    content_url: null,
    recurrence_rule: JSON.stringify({ rule: { type: 'daily', time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'UTC' } } }),
    timezone: 'UTC',
    status: 'active',
    fire_count: 3,
    created_at: 1700000000000,
    updated_at: 1700001000000,
    last_fired_at: 1700000500000,
    next_draft_uri: 'at://did:plc:alice/app.bsky.feed.post/next1',
  });

  it('maps required fields', () => {
    const view = rowToScheduleView(baseScheduleRow());
    expect(view.id).toBe('sched-uuid-1');
    expect(view.collection).toBe('app.bsky.feed.post');
    expect(view.status).toBe('active');
    expect(view.timezone).toBe('UTC');
    expect(view.fireCount).toBe(3);
  });

  it('parses recurrenceRule JSON', () => {
    const view = rowToScheduleView(baseScheduleRow());
    expect(view.recurrenceRule).toEqual({
      rule: { type: 'daily', time: { type: 'wall_time', hour: 9, minute: 0, timezone: 'UTC' } },
    });
  });

  it('includes ISO timestamps', () => {
    const view = rowToScheduleView(baseScheduleRow());
    expect(view.createdAt).toBe(new Date(1700000000000).toISOString());
    expect(view.updatedAt).toBe(new Date(1700001000000).toISOString());
  });

  it('includes lastFiredAt when set', () => {
    const view = rowToScheduleView(baseScheduleRow());
    expect(view.lastFiredAt).toBe(new Date(1700000500000).toISOString());
  });

  it('omits lastFiredAt when null', () => {
    const row = { ...baseScheduleRow(), last_fired_at: null };
    expect(rowToScheduleView(row).lastFiredAt).toBeUndefined();
  });

  it('includes nextDraftUri when set', () => {
    const view = rowToScheduleView(baseScheduleRow());
    expect(view.nextDraftUri).toBe('at://did:plc:alice/app.bsky.feed.post/next1');
  });

  it('omits nextDraftUri when null', () => {
    const row = { ...baseScheduleRow(), next_draft_uri: null };
    expect(rowToScheduleView(row).nextDraftUri).toBeUndefined();
  });

  it('includes contentUrl when set', () => {
    const row = { ...baseScheduleRow(), content_url: 'https://example.com/content' };
    expect(rowToScheduleView(row).contentUrl).toBe('https://example.com/content');
  });

  it('omits contentUrl when null', () => {
    expect(rowToScheduleView(baseScheduleRow()).contentUrl).toBeUndefined();
  });

  it('parses record JSON when set', () => {
    const view = rowToScheduleView(baseScheduleRow());
    expect(view.record).toEqual({ $type: 'app.bsky.feed.post', text: 'scheduled post' });
  });

  it('omits record when null', () => {
    const row = { ...baseScheduleRow(), record: null };
    expect(rowToScheduleView(row).record).toBeUndefined();
  });
});

describe('extractDidFromAtUri', () => {
  it('extracts DID from a valid AT-URI', () => {
    expect(extractDidFromAtUri('at://did:plc:alice/app.bsky.feed.post/abc')).toBe('did:plc:alice');
  });

  it('extracts DID:web style DID', () => {
    expect(extractDidFromAtUri('at://did:web:example.com/app.bsky.feed.post/abc')).toBe('did:web:example.com');
  });

  it('throws on an invalid AT-URI', () => {
    expect(() => extractDidFromAtUri('not-an-at-uri')).toThrow('Invalid AT-URI');
  });

  it('throws when AT-URI has no DID segment', () => {
    expect(() => extractDidFromAtUri('at:///')).toThrow('Invalid AT-URI');
  });
});
