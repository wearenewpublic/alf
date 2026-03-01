# ALF API Reference

All endpoints require a valid ATProto Bearer token unless noted otherwise.

XRPC endpoints follow the ATProto convention:
- **Queries** (`type: query`) → `GET /xrpc/<method-id>?param=value`
- **Procedures** (`type: procedure`) → `POST /xrpc/<method-id>` with `Content-Type: application/json`

---

## Write interface (proxied ATProto methods)

These endpoints mirror the standard ATProto repo write API. Instead of writing to the PDS, ALF stores the record as a draft.

### `com.atproto.repo.createRecord`

Create a draft record. If `x-scheduled-at` is provided, the draft is immediately scheduled via a `once` recurrence schedule. If `x-trigger: webhook` is provided, a one-time secret URL is returned that publishes the draft on demand.

**Request headers:**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <access-token>` |
| `x-scheduled-at` | No | ISO 8601 datetime. Creates a `once` schedule; draft gets a `scheduleId`. |
| `x-trigger` | No | Set to `webhook` to generate a one-time trigger URL instead of a fixed schedule. |

**Request body:**

```jsonc
{
  "repo": "did:plc:alice",           // Must match authenticated user
  "collection": "app.bsky.feed.post",
  "rkey": "3kw9mts3abc",             // Optional; auto-generated TID if omitted
  "record": { ... }                  // The ATProto record
}
```

**Response (200):**

```jsonc
{
  "uri": "at://did:plc:alice/app.bsky.feed.post/3kw9mts3abc",
  "cid": "bafyreib...",
  "validationStatus": "unknown",
  "triggerUrl": "https://alf.example.com/triggers/..."  // Only when x-trigger: webhook
}
```

**Errors:**

| Code | Description |
|------|-------------|
| `InvalidRequest` (400) | Missing `collection` or `record`; `repo` doesn't match authenticated user |
| `DuplicateDraft` (400) | A draft with this URI already exists and is not cancelled/published |
| `AuthRequired` (401) | Missing or invalid Bearer token |

---

### `com.atproto.repo.putRecord`

Create a draft for a `putRecord` (create-or-update) operation.

**Request headers:** Same as `createRecord` (including `x-scheduled-at` and `x-trigger`).

**Request body:**

```jsonc
{
  "repo": "did:plc:alice",
  "collection": "app.bsky.actor.profile",
  "rkey": "self",
  "record": { ... }
}
```

**Response (200):** Same shape as `createRecord`.

---

### `com.atproto.repo.deleteRecord`

Create a draft for a `deleteRecord` operation. No record content is needed.

**Request headers:** Same as `createRecord` (including `x-scheduled-at` and `x-trigger`).

**Request body:**

```jsonc
{
  "repo": "did:plc:alice",
  "collection": "app.bsky.feed.post",
  "rkey": "3kw9mts3abc"
}
```

**Response (200):**

```jsonc
{}
```

---

## Draft management methods

### `town.roundabout.scheduledPosts.listPosts`

List drafts for a user. Users can only list their own drafts.

**Query parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `repo` | Yes | DID of the user. Must match the authenticated user. |
| `status` | No | Filter by status: `draft`, `scheduled`, `publishing`, `published`, `failed`, `cancelled` |
| `limit` | No | Number of results (1–100, default 50) |
| `cursor` | No | Pagination cursor from a previous response |

**Response (200):**

```jsonc
{
  "posts": [
    { /* DraftView */ },
    { /* DraftView */ }
  ],
  "cursor": "..."  // Present if more results exist
}
```

---

### `town.roundabout.scheduledPosts.getPost`

Get a single draft by AT-URI.

**Query parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `uri` | Yes | AT-URI of the draft |

**Response (200):** A `DraftView` object.

**Errors:**

| Code | Description |
|------|-------------|
| `NotFound` (400) | No draft with this URI |
| `AuthRequired` (401) | URI belongs to a different user |

---

### `town.roundabout.scheduledPosts.schedulePost`

Set or change the publish time for a draft. The draft must be in `draft` or `scheduled` status.

**Request body:**

```jsonc
{
  "uri": "at://did:plc:alice/app.bsky.feed.post/3kw9mts3abc",
  "publishAt": "2025-06-01T09:00:00.000Z"  // ISO 8601
}
```

**Response (200):** The updated `DraftView`.

**Errors:**

| Code | Description |
|------|-------------|
| `InvalidRequest` (400) | `publishAt` is not a valid datetime |
| `NotFound` (400) | Draft not found or not in a schedulable state (e.g., already published) |
| `AuthRequired` (401) | Draft belongs to a different user |

---

### `town.roundabout.scheduledPosts.publishPost`

Immediately publish a draft to the user's PDS. This is a synchronous operation — the response reflects the final published state.

**Request body:**

```jsonc
{
  "uri": "at://did:plc:alice/app.bsky.feed.post/3kw9mts3abc"
}
```

**Response (200):** The updated `DraftView` (status will be `published` on success, or `failed` if the PDS write failed).

**Errors:**

| Code | Description |
|------|-------------|
| `NotFound` (400) | Draft not found |
| `AuthRequired` (401) | Draft belongs to a different user |

---

### `town.roundabout.scheduledPosts.updatePost`

Update the record content and/or schedule of a draft. Both `record` and `scheduledAt` are optional — only the fields provided are updated. The CID is recomputed if `record` changes.

The draft must be in `draft` or `scheduled` status.

**Request body:**

```jsonc
{
  "uri": "at://did:plc:alice/app.bsky.feed.post/3kw9mts3abc",
  "record": { ... },               // Optional: new record content
  "scheduledAt": "2025-06-01T09:00:00.000Z"  // Optional: new publish time
}
```

**Response (200):** The updated `DraftView`.

**Errors:**

| Code | Description |
|------|-------------|
| `InvalidRequest` (400) | `scheduledAt` is not a valid datetime |
| `NotFound` (400) | Draft not found or not in an updatable state |
| `AuthRequired` (401) | Draft belongs to a different user |

---

### `town.roundabout.scheduledPosts.deletePost`

Cancel and discard a draft. Sets status to `cancelled`. This is permanent.

**Request body:**

```jsonc
{
  "uri": "at://did:plc:alice/app.bsky.feed.post/3kw9mts3abc"
}
```

**Response (200):**

```jsonc
{}
```

**Errors:**

| Code | Description |
|------|-------------|
| `AuthRequired` (401) | Draft belongs to a different user |

---

## Schedule management methods

Recurring schedules fire on a recurrence rule and automatically create a new draft for each occurrence. The draft is published at the scheduled time, then the next draft is queued.

### `town.roundabout.scheduledPosts.createSchedule`

Create a recurring schedule. ALF computes the first occurrence immediately and creates a draft for it.

**Request body:**

```jsonc
{
  "collection": "app.bsky.feed.post",
  "recurrenceRule": { /* RecurrenceRule */ },
  "timezone": "America/New_York",
  "record": { ... },        // Static post content (mutually exclusive with contentUrl)
  "contentUrl": "https://..."  // Dynamic content URL (mutually exclusive with record)
}
```

**Response (200):**

```jsonc
{
  "schedule": { /* ScheduleView */ }
}
```

**Errors:**

| Code | Description |
|------|-------------|
| `InvalidRequest` (400) | `record` and `contentUrl` both provided; rule produces no future occurrences |
| `AuthRequired` (401) | Missing or invalid Bearer token |

---

### `town.roundabout.scheduledPosts.listSchedules`

List schedules for a user.

**Query parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `repo` | Yes | DID of the user. Must match the authenticated user. |
| `status` | No | Filter by status: `active`, `paused`, `cancelled`, `completed`, `error` |
| `limit` | No | Number of results (1–100, default 50) |
| `cursor` | No | Pagination cursor from a previous response |

**Response (200):**

```jsonc
{
  "schedules": [ { /* ScheduleView */ } ],
  "cursor": "..."
}
```

---

### `town.roundabout.scheduledPosts.getSchedule`

Get a single schedule by ID.

**Query parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `id` | Yes | Schedule UUID |

**Response (200):** A `ScheduleView` object.

**Errors:**

| Code | Description |
|------|-------------|
| `NotFound` (400) | No schedule with this ID |
| `AuthRequired` (401) | Schedule belongs to a different user |

---

### `town.roundabout.scheduledPosts.updateSchedule`

Pause or resume a schedule. Pausing cancels the pending next draft; resuming immediately computes and queues the next occurrence.

**Request body:**

```jsonc
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "paused"   // "paused" or "active"
}
```

**Response (200):** The updated `ScheduleView`.

**Errors:**

| Code | Description |
|------|-------------|
| `NotFound` (400) | Schedule not found |
| `AuthRequired` (401) | Schedule belongs to a different user |

---

### `town.roundabout.scheduledPosts.deleteSchedule`

Delete a schedule and cancel its pending draft. This is permanent.

**Request body:**

```jsonc
{
  "id": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Response (200):**

```jsonc
{}
```

**Errors:**

| Code | Description |
|------|-------------|
| `NotFound` (400) | Schedule not found |
| `AuthRequired` (401) | Schedule belongs to a different user |

---

## REST endpoints

### `POST /blob`

Upload a blob (image) for use in a scheduled post. ALF stores the raw bytes and returns the CID. Use the CID when constructing the record's blob references.

The blob is stored until the draft is published, at which point it is re-uploaded to the user's PDS.

**Request headers:**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <access-token>` |
| `Content-Type` | Yes | MIME type of the blob (e.g., `image/jpeg`, `image/png`) |

**Request body:** Raw image bytes (max 10MB).

**Response (200):**

```jsonc
{
  "cid": "bafkreihdwdcefgh...",
  "mimeType": "image/jpeg",
  "size": 204800
}
```

Use `cid` in blob references in your record:

```jsonc
{
  "$type": "blob",
  "ref": { "$link": "bafkreihdwdcefgh..." },
  "mimeType": "image/jpeg",
  "size": 204800
}
```

**Errors:**

| Code | Description |
|------|-------------|
| `InvalidRequest` (400) | Empty request body |
| `AuthRequired` (401) | Missing or invalid Bearer token |

---

### `POST /triggers/:key`

Fire a webhook trigger draft immediately. No authentication required — the URL itself is the secret.

**Response (200):**

```jsonc
{
  "published": true,
  "uri": "at://did:plc:alice/app.bsky.feed.post/3kw9mts3abc"
}
```

**Errors:**

| Code | Description |
|------|-------------|
| `NotFound` (404) | Trigger key not found |
| `TriggerAlreadyFired` (409) | Draft already published, failed, or cancelled |

---

### `GET /oauth/status`

Check whether the authenticated user has authorized ALF to publish on their behalf.

**Request headers:**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <access-token>` |

**Response (200):**

```jsonc
{
  "authorized": true,
  "authType": "oauth"   // "oauth" | null
}
```

If the token is invalid or the user has not authorized ALF, returns `{ "authorized": false, "authType": null }`.

---

### `GET /oauth/authorize`

Initiate the OAuth authorization flow for a user.

**Query parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `handle` | Yes | ATProto handle (e.g., `alice.bsky.social`) or DID |

Redirects the user to their PDS for authorization. After approval, the PDS redirects back to `/oauth/callback`.

---

### `GET /health`

Basic health check. No authentication required.

**Response (200):**

```jsonc
{ "status": "ok", "service": "alf" }
```

---

## DraftView object

All draft management endpoints return a `DraftView`:

```typescript
{
  uri: string;          // AT-URI: "at://did:plc:.../collection/rkey"
  cid?: string;         // Pre-computed DAG-CBOR CID; absent for deleteRecord drafts
  collection: string;   // NSID, e.g. "app.bsky.feed.post"
  rkey: string;         // Record key
  action: "create" | "put" | "delete";
  status: "draft" | "scheduled" | "publishing" | "published" | "failed" | "cancelled";
  scheduledAt?: string; // ISO 8601 datetime; absent if unscheduled
  createdAt: string;    // ISO 8601 datetime
  failureReason?: string; // Present only when status is "failed"
  record?: object;      // Record content; absent for deleteRecord drafts
  scheduleId?: string;  // UUID of the parent schedule, if this draft was created by one
  triggerUrl?: string;  // One-time webhook URL; only present on drafts with x-trigger: webhook
}
```

### Draft statuses

| Status | Description |
|--------|-------------|
| `draft` | Saved but not scheduled. Will not be published automatically. |
| `scheduled` | Has a publish time. Will be published by the scheduler. |
| `publishing` | Currently being published (claimed by scheduler). |
| `published` | Successfully written to the PDS. |
| `failed` | Failed to publish after all retry attempts. |
| `cancelled` | Cancelled by the user via `deletePost`. |

---

## ScheduleView object

Schedule management endpoints return a `ScheduleView`:

```typescript
{
  id: string;                          // UUID
  collection: string;                  // NSID, e.g. "app.bsky.feed.post"
  status: "active" | "paused" | "cancelled" | "completed" | "error";
  recurrenceRule: RecurrenceRule;      // Full rule object (see below)
  timezone: string;                    // IANA timezone
  fireCount: number;                   // Number of times this schedule has fired
  createdAt: string;                   // ISO 8601
  lastFiredAt?: string;               // ISO 8601; present after first firing
  nextDraftUri?: string;              // AT-URI of the pending next draft
  record?: object;                     // Static post content, if applicable
  contentUrl?: string;                 // Dynamic content URL, if applicable
}
```

### Schedule statuses

| Status | Description |
|--------|-------------|
| `active` | Running normally; a pending draft exists. |
| `paused` | Paused by the user; no pending draft. |
| `cancelled` | Deleted by the user. |
| `completed` | Series naturally exhausted (e.g., a `once` schedule that has fired). |
| `error` | An unrecoverable error occurred during chaining or publishing. |

---

## RecurrenceRule object

A `RecurrenceRule` is a JSON object passed to `createSchedule`. It contains a core rule plus optional bounds and exception lists.

```typescript
{
  rule: RecurrenceRuleCore;           // The core firing pattern (see below)
  startDate?: string;                 // YYYY-MM-DD: first occurrence must be on or after this date
  endDate?: string;                   // YYYY-MM-DD: no occurrences after this date
  count?: number;                     // Maximum number of total firings
  revisions?: RecurrenceRevision[];   // Time-spec changes taking effect from a given date
  exceptions?: RecurrenceException[]; // Per-occurrence overrides (cancel, move, override_time, override_payload)
}
```

### Core rule types

| Type | Description | Extra fields |
|------|-------------|--------------|
| `once` | Fires exactly once at the given UTC datetime. | `datetime: string` (ISO 8601 UTC) |
| `daily` | Every N days at the given time. | `interval?: number`, `time: TimeSpec` |
| `weekly` | Every N weeks on the specified days of the week. | `interval?: number`, `daysOfWeek: number[]` (0=Sun–6=Sat), `time: TimeSpec` |
| `monthly_on_day` | Nth day of every N-th month; clamps to last day if month is shorter. | `interval?: number`, `dayOfMonth: number` (1–31), `time: TimeSpec` |
| `monthly_nth_weekday` | Nth weekday of every N-th month (nth=-1 means last). | `interval?: number`, `nth: number` (1–4 or -1), `weekday: number` (0=Sun–6=Sat), `time: TimeSpec` |
| `monthly_last_business_day` | Last Mon–Fri of every N-th month. | `interval?: number`, `time: TimeSpec` |
| `yearly_on_month_day` | Specific month and day each year; clamps Feb 29 in non-leap years. | `interval?: number`, `month: number` (1–12), `dayOfMonth: number` (1–31), `time: TimeSpec` |
| `yearly_nth_weekday` | Nth weekday of a specific month each year. | `interval?: number`, `month: number`, `nth: number`, `weekday: number`, `time: TimeSpec` |
| `quarterly_last_weekday` | Last occurrence of a weekday in each quarter-end month (Mar, Jun, Sep, Dec). | `interval?: number` (quarters between fires, default 1), `weekday: number`, `time: TimeSpec` |

### TimeSpec

All repeating rule types include a `time` field that is one of:

```typescript
// Wall-clock time in a named timezone (DST-aware)
{ type: "wall_time", hour: number, minute: number, second?: number, timezone: string }

// Fixed UTC offset (does not adjust for DST)
{ type: "fixed_instant", utcOffsetMinutes: number, hour: number, minute: number, second?: number }
```

### Exception types

Exceptions are matched by their `date` field (a `YYYY-MM-DD` string in the rule's timezone). Multiple exceptions for different dates can coexist.

| Type | Effect | Fields |
|------|--------|--------|
| `cancel` | Skip this occurrence entirely. | `date: string` |
| `move` | Publish at a different UTC datetime instead. | `date: string`, `newDatetime: string` (ISO 8601 UTC) |
| `override_time` | Use a different time spec for this occurrence only. | `date: string`, `time: TimeSpec` |
| `override_payload` | Publish a different record for this occurrence. Resolved at publish time, not schedule time. | `date: string`, `record: object` |

### Example: daily post at 9 AM ET, skipping a holiday

```jsonc
{
  "rule": {
    "type": "daily",
    "time": { "type": "wall_time", "hour": 9, "minute": 0, "timezone": "America/New_York" }
  },
  "exceptions": [
    { "type": "cancel", "date": "2025-07-04" },
    { "type": "override_payload", "date": "2025-12-25", "record": {
      "$type": "app.bsky.feed.post", "text": "Happy holidays!", "createdAt": "2025-12-25T00:00:00Z"
    }}
  ]
}
```

### Example: once schedule

```jsonc
{
  "rule": { "type": "once", "datetime": "2025-06-01T14:00:00Z" }
}
```

> **Note:** Using `x-scheduled-at` on `createRecord` or `putRecord` automatically creates a `once` schedule behind the scenes. The returned draft will have a `scheduleId` pointing to it.

### Dynamic content schedules

If `contentUrl` is provided instead of `record`, ALF fetches the URL at publish time with two query parameters:

| Parameter | Description |
|-----------|-------------|
| `fireCount` | 1-based count of how many times this schedule has fired (including this firing) |
| `scheduledAt` | ISO 8601 datetime of the scheduled occurrence |

The response must be a JSON object that is the record to publish.
