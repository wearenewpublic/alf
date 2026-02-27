// Tests for schema utility functions

import { rowToDraftView, extractDidFromAtUri } from '../schema';
import type { DraftRow } from '../schema';

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
