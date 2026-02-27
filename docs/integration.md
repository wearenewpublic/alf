# ALF Integration Guide

This guide is for developers who have an existing ATProto or Bluesky posting tool and want to add scheduled posting without redesigning their data model. ALF acts as a transparent proxy: the app changes its base URL, adds one header, and gains a full drafts and scheduling system backed by the user's own PDS.

---

## 1. When to use ALF

If your app already posts records to ATProto — whether you're building a Bluesky client, a cross-posting tool, or an automation bot — ALF fits into your stack with minimal code changes.

The central idea is that ALF looks exactly like a PDS from your app's perspective. Your app calls the same three ATProto write methods (`com.atproto.repo.createRecord`, `com.atproto.repo.putRecord`, `com.atproto.repo.deleteRecord`) against ALF instead of against the user's PDS. ALF intercepts the write, stores it as a draft, and publishes it to the actual PDS at the requested time. The user authorizes ALF once via OAuth, and from that point forward ALF holds a refresh token it uses at publish time.

```
Your app  →  ALF (stores draft)  →  User's PDS (at scheduled time)
```

The only changes required in your app are:

1. Point write calls at the ALF URL instead of the PDS URL.
2. Add an `x-scheduled-at` header with the desired publish time.
3. Redirect users through ALF's OAuth flow once.

Everything else — your record schema, your existing ATProto client library, your blob upload code — stays the same.

ALF is the right fit when:

- You want to schedule posts without building and maintaining a scheduler yourself.
- You want drafts stored durably (surviving process restarts) with retry logic built in.
- You want to avoid storing user credentials; ALF uses OAuth with DPoP and encrypts tokens at rest.

ALF is not the right fit if you need real-time writes that cannot tolerate even a brief delay, or if you need to support non-ATProto platforms directly.

---

## 2. Step 1 — Run ALF

See the [quick start in the README](../README.md#quick-start) for full setup instructions. The short version:

```bash
# Generate the required encryption key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# With Docker Compose
git clone https://github.com/your-org/alf.git
cd alf
echo "ENCRYPTION_KEY=<your-64-char-hex-key>" > .env
docker compose up -d

curl http://localhost:3005/health
# {"status":"ok","service":"alf"}
```

The key environment variables you must configure before going to production:

| Variable | Notes |
|---|---|
| `ENCRYPTION_KEY` | Required. 64-character hex string (32 bytes). All refresh tokens and DPoP keys are encrypted with this key at rest. Generate with the command above and treat it like a secret. |
| `SERVICE_URL` | Required in production. The public HTTPS URL of your ALF instance, e.g. `https://alf.example.com`. ATProto OAuth requires HTTPS for client metadata discovery — OAuth will not work with an `http://` URL except on localhost. |
| `DATABASE_TYPE` | `sqlite` (default) for single-node deployments, `postgres` for persistent external storage. |
| `DATABASE_URL` | Required if `DATABASE_TYPE=postgres`. |
| `POST_PUBLISH_WEBHOOK_URL` | Optional. ALF POSTs here after each successful publish. |
| `OAUTH_SUCCESS_REDIRECT` | Optional. Redirect destination after OAuth authorization completes. |

> **Important:** `SERVICE_URL` must be an HTTPS URL in any non-local environment. The ATProto OAuth specification requires client metadata to be served over HTTPS. If you set `SERVICE_URL=http://...` in production, PDSes will refuse to authorize ALF.

---

## 3. Step 2 — Authorize ALF for your users

This is the most important integration step. Before ALF can publish anything for a user, the user must authorize ALF through their PDS's OAuth consent screen. This authorization needs to happen only once per user; ALF stores the resulting refresh token (encrypted) and handles token renewal automatically.

### How the flow works

1. Your app redirects the user to ALF's authorization endpoint.
2. ALF redirects the user to their PDS, which shows an OAuth consent screen.
3. The user approves. The PDS redirects back to ALF's callback URL.
4. ALF exchanges the code for tokens, stores them encrypted, and either redirects to your app or returns JSON.

From that point on, ALF can publish on behalf of that user at any time — including in the middle of the night when the user's client is not connected.

### Starting the OAuth flow

Redirect the user's browser to:

```
GET https://alf.example.com/oauth/authorize?handle=alice.bsky.social
```

The `handle` parameter can be any ATProto handle or DID. ALF resolves the handle to a DID, discovers the user's PDS, and initiates a PKCE-based OAuth flow.

After the user approves on their PDS, ALF completes the handshake. If you have set `OAUTH_SUCCESS_REDIRECT`, ALF redirects the user's browser to:

```
https://your-app.example.com/auth/callback?did=did:plc:alice...
```

The `did` query parameter contains the user's DID so your app knows which user just authorized. If `OAUTH_SUCCESS_REDIRECT` is not set, ALF returns a JSON response:

```json
{
  "success": true,
  "did": "did:plc:alice...",
  "message": "Authorization successful. You can now use the scheduled posts service."
}
```

### Checking authorization status

Before creating scheduled posts for a user, check whether ALF has a valid authorization. Use the user's own access token (the one they use to authenticate to their PDS, not a token issued by ALF):

```
GET https://alf.example.com/oauth/status
Authorization: Bearer <user-access-token>
```

Response when authorized:

```json
{
  "authorized": true,
  "authType": "oauth"
}
```

Response when not yet authorized:

```json
{
  "authorized": false,
  "authType": null
}
```

### A note on tokens

ALF does not issue its own tokens. The Bearer token your app sends to ALF is the same access token the user would use to make direct XRPC calls to their PDS. ALF verifies this token against the user's PDS JWKS endpoint to confirm the caller's identity, then uses its own separately stored refresh token (the one from the OAuth flow above) to perform the actual PDS write at publish time.

This means your app's existing auth flow is unchanged. However, access tokens are short-lived (typically an hour). For operations that happen immediately this is fine. For the scheduled publish itself, ALF uses its own stored credentials — your app's token is only used to authenticate management calls to ALF.

### Example: status check and authorization redirect in TypeScript

```typescript
async function ensureAlfAuthorized(
  alfBaseUrl: string,
  userAccessToken: string,
  userHandle: string,
): Promise<boolean> {
  const response = await fetch(`${alfBaseUrl}/oauth/status`, {
    headers: {
      Authorization: `Bearer ${userAccessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`ALF status check failed: ${response.status}`);
  }

  const { authorized } = await response.json() as { authorized: boolean };

  if (!authorized) {
    // Redirect the user's browser to start the OAuth flow.
    // In a web app, you would do this with a redirect response or window.location.
    const authUrl = `${alfBaseUrl}/oauth/authorize?handle=${encodeURIComponent(userHandle)}`;
    console.log(`User needs to authorize ALF. Redirect them to: ${authUrl}`);
    // e.g., res.redirect(authUrl) in an Express handler
    return false;
  }

  return true;
}
```

In a server-rendered web app, the flow typically looks like this:

```typescript
// Express route: user clicks "Connect scheduling"
app.get('/connect-scheduling', (req, res) => {
  const alfUrl = process.env.ALF_URL!;
  const handle = req.session.user.handle;
  res.redirect(`${alfUrl}/oauth/authorize?handle=${encodeURIComponent(handle)}`);
});

// Express route: ALF redirects back here (set OAUTH_SUCCESS_REDIRECT to this URL)
app.get('/auth/callback', async (req, res) => {
  const { did } = req.query as { did: string };
  // Mark this user as connected in your own database
  await db.users.update({ did }, { alfAuthorized: true });
  res.redirect('/dashboard?scheduling=connected');
});
```

---

## 4. Step 3 — Redirect writes to ALF

Once the user has authorized ALF, schedule a post by sending the same XRPC request your app already sends, but with two changes:

1. Use the ALF base URL instead of the user's PDS URL.
2. Add the `x-scheduled-at` header with an ISO 8601 datetime.

### Before (posting directly to the PDS)

```typescript
const pdsUrl = 'https://bsky.social'; // or the user's actual PDS URL

const response = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.createRecord`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    repo: userDid,
    collection: 'app.bsky.feed.post',
    record: {
      $type: 'app.bsky.feed.post',
      text: 'Hello world!',
      createdAt: new Date().toISOString(),
    },
  }),
});

const { uri, cid } = await response.json();
```

### After (posting through ALF with a schedule)

```typescript
const alfUrl = 'https://alf.example.com'; // your ALF instance

const scheduledAt = new Date('2026-03-01T09:00:00.000Z').toISOString();

const response = await fetch(`${alfUrl}/xrpc/com.atproto.repo.createRecord`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'x-scheduled-at': scheduledAt, // <-- the only addition
  },
  body: JSON.stringify({
    repo: userDid,
    collection: 'app.bsky.feed.post',
    record: {
      $type: 'app.bsky.feed.post',
      text: 'Hello world!',
      createdAt: new Date().toISOString(),
    },
  }),
});

const { uri, cid } = await response.json();
// uri = "at://did:plc:alice.../app.bsky.feed.post/3kw9mts3abc"
```

The response has the same shape as a real PDS response, so existing code that reads `uri` and `cid` from the response will continue to work.

### Creating an unscheduled draft

Omit `x-scheduled-at` entirely to create a draft that will not publish automatically (status `draft`). You can schedule it later using `town.roundabout.scheduledPosts.schedulePost` or publish it immediately with `town.roundabout.scheduledPosts.publishPost`.

### Provisional CID

The `cid` returned by ALF is computed deterministically from the record content (using DAG-CBOR encoding and SHA-256) before the record exists on the PDS. This CID will match the CID the PDS assigns when it ingests the record, because ATProto uses the same algorithm. However, you should not treat the `cid` as authoritative until you confirm it via the user's PDS or via the webhook (see Section 7). Do not display it as an immutable link or use it in other records until the draft has published.

### Using `putRecord` and `deleteRecord`

ALF supports all three write methods:

```typescript
// Schedule a profile update
await fetch(`${alfUrl}/xrpc/com.atproto.repo.putRecord`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'x-scheduled-at': scheduledAt,
  },
  body: JSON.stringify({
    repo: userDid,
    collection: 'app.bsky.actor.profile',
    rkey: 'self',
    record: { $type: 'app.bsky.actor.profile', displayName: 'New Name' },
  }),
});

// Schedule a post deletion
await fetch(`${alfUrl}/xrpc/com.atproto.repo.deleteRecord`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'x-scheduled-at': scheduledAt,
  },
  body: JSON.stringify({
    repo: userDid,
    collection: 'app.bsky.feed.post',
    rkey: '3kw9mts3abc',
  }),
});
```

---

## 5. Step 4 — Handle blobs

If your posts include images or other blobs, you must upload them to ALF before creating the record that references them. ALF stores the raw bytes in its database and re-uploads them to the user's PDS when the draft publishes. This is necessary because:

- The PDS blob upload session from when the draft was created may have expired by publish time.
- The blob needs to exist on the user's PDS, not just in a temporary upload session.

### Upload a blob to ALF

```typescript
const imageBytes = await fs.promises.readFile('./photo.jpg');

const blobResponse = await fetch(`${alfUrl}/blob`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'image/jpeg',
  },
  body: imageBytes,
});

if (!blobResponse.ok) {
  throw new Error(`Blob upload failed: ${blobResponse.status}`);
}

const { cid, mimeType, size } = await blobResponse.json() as {
  cid: string;
  mimeType: string;
  size: number;
};
// cid = "bafkreihdwdcefgh..."
```

The blob endpoint accepts any content type and allows uploads up to 10MB.

### Reference the blob in your record

Use the CID returned by ALF when constructing blob references in your record. The ATProto blob ref format is:

```typescript
const post = {
  $type: 'app.bsky.feed.post',
  text: 'Check out this photo',
  embed: {
    $type: 'app.bsky.embed.images',
    images: [
      {
        image: {
          $type: 'blob',
          ref: { $link: cid },   // use the CID from the ALF blob upload
          mimeType,
          size,
        },
        alt: 'A photo of a sunset',
      },
    ],
  },
  createdAt: new Date().toISOString(),
};

await fetch(`${alfUrl}/xrpc/com.atproto.repo.createRecord`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'x-scheduled-at': scheduledAt,
  },
  body: JSON.stringify({
    repo: userDid,
    collection: 'app.bsky.feed.post',
    record: post,
  }),
});
```

### Full blob upload and post creation example

```typescript
async function schedulePostWithImage(
  alfUrl: string,
  accessToken: string,
  userDid: string,
  imageBuffer: Buffer,
  imageMimeType: string,
  postText: string,
  altText: string,
  publishAt: Date,
): Promise<{ uri: string; cid: string }> {
  // 1. Upload the image to ALF
  const blobResponse = await fetch(`${alfUrl}/blob`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': imageMimeType,
    },
    body: imageBuffer,
  });

  if (!blobResponse.ok) {
    const err = await blobResponse.json();
    throw new Error(`Blob upload failed: ${JSON.stringify(err)}`);
  }

  const blob = await blobResponse.json() as { cid: string; mimeType: string; size: number };

  // 2. Build the record with the blob reference
  const record = {
    $type: 'app.bsky.feed.post',
    text: postText,
    embed: {
      $type: 'app.bsky.embed.images',
      images: [
        {
          image: {
            $type: 'blob',
            ref: { $link: blob.cid },
            mimeType: blob.mimeType,
            size: blob.size,
          },
          alt: altText,
        },
      ],
    },
    createdAt: new Date().toISOString(),
  };

  // 3. Create the scheduled record
  const postResponse = await fetch(`${alfUrl}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'x-scheduled-at': publishAt.toISOString(),
    },
    body: JSON.stringify({
      repo: userDid,
      collection: 'app.bsky.feed.post',
      record,
    }),
  });

  if (!postResponse.ok) {
    const err = await postResponse.json();
    throw new Error(`Draft creation failed: ${JSON.stringify(err)}`);
  }

  return postResponse.json() as Promise<{ uri: string; cid: string }>;
}
```

---

## 6. Step 5 — Manage drafts

ALF exposes a set of custom XRPC methods under the `town.roundabout.scheduledPosts` namespace for listing, inspecting, updating, and managing drafts. These methods are defined in ALF's own lexicons.

All draft management methods follow ATProto XRPC conventions:
- **Queries** (`type: query`) use `GET /xrpc/<method-id>?param=value`
- **Procedures** (`type: procedure`) use `POST /xrpc/<method-id>` with `Content-Type: application/json`

All endpoints require a valid Bearer token. Users can only access their own drafts.

### The DraftView object

All draft management endpoints return a `DraftView`:

```typescript
interface DraftView {
  uri: string;             // AT-URI: "at://did:plc:.../collection/rkey"
  cid?: string;            // Pre-computed CID; absent for deleteRecord drafts
  collection: string;      // NSID, e.g. "app.bsky.feed.post"
  rkey: string;            // Record key
  action: 'create' | 'put' | 'delete';
  status: 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'cancelled';
  scheduledAt?: string;    // ISO 8601; absent if not scheduled
  createdAt: string;       // ISO 8601
  failureReason?: string;  // Present only when status is "failed"
  record?: object;         // Record content; absent for deleteRecord drafts
}
```

Example `DraftView`:

```json
{
  "uri": "at://did:plc:alice.../app.bsky.feed.post/3kw9mts3abc",
  "cid": "bafyreib4pga3hqnm7ugriqy...",
  "collection": "app.bsky.feed.post",
  "rkey": "3kw9mts3abc",
  "action": "create",
  "status": "scheduled",
  "scheduledAt": "2026-03-01T09:00:00.000Z",
  "createdAt": "2026-02-24T14:32:00.000Z",
  "record": {
    "$type": "app.bsky.feed.post",
    "text": "Hello world!",
    "createdAt": "2026-02-24T14:32:00.000Z"
  }
}
```

### List drafts: `town.roundabout.scheduledPosts.listPosts`

Fetch a paginated list of drafts for a user. Supports filtering by status.

```
GET /xrpc/town.roundabout.scheduledPosts.listPosts?repo=<did>&status=<status>&limit=<n>&cursor=<cursor>
Authorization: Bearer <access-token>
```

Parameters:

| Parameter | Required | Description |
|---|---|---|
| `repo` | Yes | DID of the user. Must match the authenticated user. |
| `status` | No | Filter: `draft`, `scheduled`, `publishing`, `published`, `failed`, `cancelled` |
| `limit` | No | 1–100, default 50 |
| `cursor` | No | Pagination cursor from a previous response |

```typescript
async function listScheduledPosts(
  alfUrl: string,
  accessToken: string,
  userDid: string,
): Promise<{ posts: DraftView[]; cursor?: string }> {
  const params = new URLSearchParams({
    repo: userDid,
    status: 'scheduled',
    limit: '50',
  });

  const response = await fetch(
    `${alfUrl}/xrpc/town.roundabout.scheduledPosts.listPosts?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!response.ok) throw new Error(`List failed: ${response.status}`);
  return response.json();
}
```

Response:

```json
{
  "posts": [
    { /* DraftView */ },
    { /* DraftView */ }
  ],
  "cursor": "3kw9mts3xyz"
}
```

The `cursor` field is absent when there are no more results.

### Get a single draft: `town.roundabout.scheduledPosts.getPost`

```
GET /xrpc/town.roundabout.scheduledPosts.getPost?uri=<at-uri>
Authorization: Bearer <access-token>
```

```typescript
const response = await fetch(
  `${alfUrl}/xrpc/town.roundabout.scheduledPosts.getPost?uri=${encodeURIComponent(draftUri)}`,
  { headers: { Authorization: `Bearer ${accessToken}` } },
);

const draft = await response.json() as DraftView;
```

### Update a draft: `town.roundabout.scheduledPosts.updatePost`

Change the record content, the scheduled time, or both. Only the fields you provide are updated. The draft must be in `draft` or `scheduled` status.

```
POST /xrpc/town.roundabout.scheduledPosts.updatePost
Authorization: Bearer <access-token>
Content-Type: application/json
```

```typescript
// Reschedule to a different time
const response = await fetch(
  `${alfUrl}/xrpc/town.roundabout.scheduledPosts.updatePost`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      uri: draftUri,
      scheduledAt: '2026-03-15T12:00:00.000Z',
    }),
  },
);

const updated = await response.json() as DraftView;
```

```typescript
// Edit the text and reschedule in one call
const response = await fetch(
  `${alfUrl}/xrpc/town.roundabout.scheduledPosts.updatePost`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      uri: draftUri,
      record: {
        $type: 'app.bsky.feed.post',
        text: 'Updated text for this post',
        createdAt: new Date().toISOString(),
      },
      scheduledAt: '2026-03-15T12:00:00.000Z',
    }),
  },
);
```

### Schedule an unscheduled draft: `town.roundabout.scheduledPosts.schedulePost`

Assign a publish time to a draft that is currently in `draft` status (no schedule set).

```typescript
const response = await fetch(
  `${alfUrl}/xrpc/town.roundabout.scheduledPosts.schedulePost`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      uri: draftUri,
      publishAt: '2026-03-01T09:00:00.000Z',
    }),
  },
);

const draft = await response.json() as DraftView;
// draft.status === "scheduled"
```

### Publish immediately: `town.roundabout.scheduledPosts.publishPost`

Force-publish a draft right now, bypassing the scheduler. This is a synchronous operation — the response reflects the outcome of the PDS write.

```typescript
const response = await fetch(
  `${alfUrl}/xrpc/town.roundabout.scheduledPosts.publishPost`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ uri: draftUri }),
  },
);

const draft = await response.json() as DraftView;
if (draft.status === 'published') {
  console.log('Published successfully');
} else if (draft.status === 'failed') {
  console.error('Publish failed:', draft.failureReason);
}
```

### Cancel a draft: `town.roundabout.scheduledPosts.deletePost`

Discard a draft permanently. Sets its status to `cancelled`. This cannot be undone.

```typescript
await fetch(
  `${alfUrl}/xrpc/town.roundabout.scheduledPosts.deletePost`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ uri: draftUri }),
  },
);
```

---

## 7. Webhook integration

When `POST_PUBLISH_WEBHOOK_URL` is set, ALF sends a POST request to that URL immediately after each successful publish. This lets your app react to publishes in real time without polling.

### Payload

```json
POST https://your-service.example.com/hooks/alf-published
Content-Type: application/json

{
  "uri": "at://did:plc:alice.../app.bsky.feed.post/3kw9mts3abc",
  "publishedAt": "2026-03-01T09:00:04.123Z"
}
```

The `uri` is the AT-URI of the record that was just written to the PDS. `publishedAt` is the wall-clock time the publish completed.

### Receiving webhooks

```typescript
import express from 'express';

const app = express();
app.use(express.json());

app.post('/hooks/alf-published', async (req, res) => {
  const { uri, publishedAt } = req.body as {
    uri: string;
    publishedAt: string;
  };

  // Acknowledge receipt immediately — do heavy work asynchronously
  res.status(200).json({ ok: true });

  // Update your own database
  await db.posts.update(
    { draftUri: uri },
    { status: 'published', publishedAt: new Date(publishedAt) },
  );

  // Send a push notification, update a feed, etc.
  await notifyUser({ uri, publishedAt });
});
```

### Use cases

- **Sync your own database:** Mark the post as published, store the final AT-URI.
- **Send notifications:** Push a confirmation to the user that their scheduled post went live.
- **Chain workflows:** Trigger analytics ingestion, cross-posting to other platforms, or follow-up actions.
- **Update UI state:** Invalidate a cache so the user's dashboard reflects the published post.

### Reliability

ALF fires the webhook request once after a successful publish and does not automatically retry on failure. If your webhook endpoint returns a 5xx status, ALF logs the failure but the draft is still marked published — the PDS write already happened. Design your webhook handler to be idempotent (safe to call more than once with the same `uri`). If you need retry guarantees, consider adding a queue between ALF's webhook and your processing logic.

---

## 8. Gotchas and edge cases

### Scheduled time in the past publishes immediately

If you supply an `x-scheduled-at` value that is in the past, ALF does not return an error. The draft is created with `status: scheduled`, and the scheduler picks it up at its next wakeup (usually within seconds). This means "schedule for the past" is equivalent to "publish as soon as possible." This is by design and is useful for retry scenarios, but be aware of it if you are deriving `scheduledAt` from user input without validation.

### Failed drafts require manual intervention

If a draft fails to publish and exhausts all three retry attempts (at 1 minute, 5 minutes, and 15 minutes), its status becomes `failed` and it will not be retried again automatically. The `failureReason` field in the `DraftView` contains the error message.

To handle failed drafts in your app:

```typescript
// Find all failed drafts for a user
const { posts } = await listDrafts(alfUrl, accessToken, userDid, 'failed');

for (const draft of posts) {
  console.log(`Failed: ${draft.uri}`);
  console.log(`Reason: ${draft.failureReason}`);

  // Option 1: retry by publishing immediately
  await publishPost(alfUrl, accessToken, draft.uri);

  // Option 2: discard
  await cancelPost(alfUrl, accessToken, draft.uri);
}
```

Common failure reasons include OAuth token revocation (the user revoked ALF's access on their PDS) and transient PDS errors. If the failure reason mentions `oauth_revoked` or `no_oauth_authorization`, the user needs to re-authorize ALF before any further publishes will succeed.

### OAuth must be completed before drafts can publish

You can create drafts for a user before they have authorized ALF. The drafts are stored and will be scheduled, but the scheduler will immediately mark them `failed` when it tries to publish because there is no refresh token. Make sure users complete the OAuth flow before their first scheduled post is due to publish.

A good pattern is to gate the "schedule a post" feature behind an authorization check:

```typescript
async function schedulePost(/* ... */) {
  const { authorized } = await checkAlfStatus(alfUrl, accessToken);
  if (!authorized) {
    throw new Error('Please authorize ALF before scheduling posts.');
  }
  // proceed with scheduling
}
```

### The provisional CID is not the permanent AT-URI key

The `cid` in the response from `createRecord` and `putRecord` is computed by ALF before the record exists on the PDS, using the same DAG-CBOR + SHA-256 algorithm ATProto uses. In practice it matches what the PDS will assign. However, the PDS is the authoritative source of record CIDs and AT-URIs. Do not cache the CID for use in embed references or quote-posts until you have confirmed it via the user's PDS repo or via a webhook notification.

### Multiple ALF instances sharing a database are not supported

The scheduler uses in-process locking to claim drafts atomically. Running two ALF processes against the same database will result in race conditions and double-publishes. If you need horizontal scaling, run a single ALF instance and scale your PDS interactions instead. For high-availability deployments, use a process supervisor (systemd, Docker restart policies) to keep a single ALF instance running rather than multiple concurrent instances.

### The demo app is a working reference

The `demo/` directory at the root of the ALF repository contains a working reference implementation of the client integration. If you get stuck or want to see a complete example of the OAuth flow, blob upload, and draft management all working together, start there.
