# ALF API Reference

All endpoints require a valid ATProto Bearer token unless noted otherwise.

XRPC endpoints follow the ATProto convention:
- **Queries** (`type: query`) → `GET /xrpc/<method-id>?param=value`
- **Procedures** (`type: procedure`) → `POST /xrpc/<method-id>` with `Content-Type: application/json`

---

## Write interface (proxied ATProto methods)

These endpoints mirror the standard ATProto repo write API. Instead of writing to the PDS, ALF stores the record as a draft.

### `com.atproto.repo.createRecord`

Create a draft record. If `x-scheduled-at` is provided, the draft is immediately scheduled.

**Request headers:**

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <access-token>` |
| `x-scheduled-at` | No | ISO 8601 datetime. If set, draft is created with status `scheduled`. |

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
  "validationStatus": "unknown"
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

**Request headers:** Same as `createRecord`.

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

**Request headers:** Same as `createRecord`.

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

