<p align="center"><img src="demo/public/logo.png" alt="ALF" width="120"></p>

# atproto Latency Fabric

atproto Latency Fabric is a drafts store and scheduler for [atproto](https://atproto.com) records. It acts as a transparent proxy that intercepts atproto write calls, stores them as drafts, and publishes them to the user's PDS at the scheduled time.

Use it to add scheduled posting, drafts, or queued writes to any atproto client app.

## How it works

<p align="center">
  <img src="assets/diagram-flow.png" alt="How it works" width="760">
</p>

1. Your client app points atproto write calls at atproto Latency Fabric instead of directly at the PDS
2. The record is stored as a draft, with an optional publish time via the `x-scheduled-at` header
3. The scheduler wakes up when the publish time arrives and writes the record to the user's PDS
4. Images are stored at upload time and re-uploaded to the PDS when the post goes out

## Demo

Try the live demo at **[alf.fly.dev](https://alf.fly.dev)** (limited to 3 active drafts per user).

The `demo/` directory contains a standalone web app that walks through the full ALF integration: OAuth sign-in, authorizing ALF, scheduling posts with images, and managing drafts. See [docs/demo.md](docs/demo.md) for setup and run instructions. ALF must be running locally before you start the demo.

## Quick start

### Prerequisites

Generate an encryption key for storing tokens at rest:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### With Docker Compose

```bash
git clone https://github.com/wearenewpublic/alf.git
-or-
git clone https://tangled.sh/newpublic.org/alf

cd alf

echo "ENCRYPTION_KEY=your-64-char-hex-key-here" > .env

docker compose up -d

curl http://localhost:1986/health
# {"status":"ok","service":"alf"}
```

### Local development

```bash
npm install
cp .env.example .env
# Edit .env: set ENCRYPTION_KEY

npm run dev
```

## Configuration

All configuration is via environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `1986` | HTTP port |
| `SERVICE_URL` | No | `http://localhost:1986` | Public URL of this service (used for OAuth client metadata discovery) |
| `PLC_ROOT` | No | `https://plc.directory` | atproto PLC directory |
| `HANDLE_RESOLVER_URL` | No | `https://api.bsky.app` | Handle-to-DID resolver |
| `ENCRYPTION_KEY` | **Yes** | — | 64-char hex string (32 bytes) for AES-256-GCM encryption of stored tokens |
| `DATABASE_TYPE` | No | `sqlite` | `sqlite` or `postgres` |
| `DATABASE_PATH` | No | `./data/alf.db` | SQLite file path |
| `DATABASE_URL` | If postgres | — | PostgreSQL connection string |
| `POST_PUBLISH_WEBHOOK_URL` | No | — | URL to POST to after each successful publish |
| `MAX_DRAFTS_PER_USER` | No | — | Maximum active drafts per user (unset = unlimited) |

## Authentication

atproto Latency Fabric uses atproto OAuth with DPoP. The user authorizes once and a refresh token is stored (encrypted at rest) to use at publish time.

**Flow:**
1. Redirect the user to `GET /oauth/authorize?handle=alice.bsky.social`
2. The user approves on their PDS
3. The service exchanges the code for a refresh token and stores it encrypted

**Check status:**
```
GET /oauth/status
Authorization: Bearer <user-access-token>

→ { "authorized": true, "authType": "oauth" }
```

`SERVICE_URL` must be an HTTPS URL in production for OAuth client metadata discovery to work.

## Client integration

### Creating a scheduled post (Bluesky example)

Point your write calls at atproto Latency Fabric and include the `x-scheduled-at` header:

```typescript
const response = await fetch('https://alf.example.com/xrpc/com.atproto.repo.createRecord', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'x-scheduled-at': '2025-06-01T09:00:00.000Z',
  },
  body: JSON.stringify({
    repo: userDid,
    collection: 'app.bsky.feed.post',
    record: {
      $type: 'app.bsky.feed.post',
      text: 'This will post at 9am on June 1st',
      createdAt: new Date().toISOString(),
    },
  }),
});

const { uri, cid } = await response.json();
// uri = "at://did:plc:alice/app.bsky.feed.post/3kw9mts3abc"
```

Omitting `x-scheduled-at` creates an unscheduled draft (status `draft`).

### Uploading images

Upload blobs before creating the record. Raw bytes are stored and re-uploaded to the PDS at publish time.

```typescript
// 1. Upload the image
const blobResponse = await fetch('https://alf.example.com/blob', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'image/jpeg',
  },
  body: imageBytes,
});

const { cid, mimeType, size } = await blobResponse.json();
// cid = "bafkreihdwdcefgh..."

// 2. Reference the blob in the record using atproto blob ref format
const post = {
  $type: 'app.bsky.feed.post',
  text: 'Check out this photo',
  embed: {
    $type: 'app.bsky.embed.images',
    images: [{
      image: { $type: 'blob', ref: { $link: cid }, mimeType, size },
      alt: 'A photo',
    }],
  },
  createdAt: new Date().toISOString(),
};

// 3. Create the scheduled record as normal
await fetch('https://alf.example.com/xrpc/com.atproto.repo.createRecord', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'x-scheduled-at': '2025-06-01T09:00:00.000Z',
  },
  body: JSON.stringify({ repo: userDid, collection: 'app.bsky.feed.post', record: post }),
});
```

## API reference

See [docs/api.md](docs/api.md) for the full API reference.

## Post-publish webhook

When `POST_PUBLISH_WEBHOOK_URL` is set, a POST request is sent after each successful publish:

```json
POST https://your-service.example.com/hooks/post-published
Content-Type: application/json

{
  "uri": "at://did:plc:alice/app.bsky.feed.post/3kw9mts3abc",
  "publishedAt": "2025-06-01T09:00:04.123Z"
}
```

Webhook failures are logged and non-fatal — the draft is still marked published.

## Architecture

### Event-driven scheduler

The scheduler is sleep-based rather than a polling loop. On startup, it calculates the delay until the next scheduled draft and sets a single timeout. When a draft is added or updated, `notifyScheduler()` recalculates the next wakeup. Idle CPU usage is effectively zero.

### Retry logic

Failed publishes are retried with exponential backoff:

| Attempt | Retry delay |
|---------|-------------|
| 1 | 1 minute |
| 2 | 5 minutes |
| 3 | 15 minutes |
| 4+ | marked `failed` |

### Blob storage

Uploaded blobs are stored as raw bytes in the database, keyed by their CIDv1 (raw codec, SHA-256). At publish time, blobs are re-uploaded to the user's PDS before writing the record. This ensures images remain available even if the client's original blob upload session has expired.

### Security

- All refresh tokens and DPoP private keys are encrypted at rest with AES-256-GCM using the `ENCRYPTION_KEY`
- Users can only read and manage their own drafts; ownership is verified by checking the DID in the AT-URI against the authenticated user
- Bearer tokens are verified against the user's PDS via JWKS (OAuth)

## Deployment

See [docs/deployment.md](docs/deployment.md) for deployment instructions including Docker, Fly.io, Railway, Render, and bare-metal.

### PostgreSQL

```bash
DATABASE_TYPE=postgres
DATABASE_URL=postgresql://user:pass@db.example.com:5432/alf
```

### Metrics

In production, Prometheus metrics are exposed on port 9091 at `/metrics`. Metrics cover draft operations, blob storage, scheduler wakeups, publish durations, and HTTP request rates.

## Development

```bash
npm install
cp .env.example .env
# Set ENCRYPTION_KEY in .env

npm run dev          # Watch mode
npm test             # Run tests
npm run test:coverage  # Tests with coverage report
npm run build        # Compile to dist/
npm run lint         # ESLint
```

Tests use Jest with 100% coverage thresholds. Test files are in `src/__tests__/`.

## About

ALF was built as part of [Roundabout](https://joinroundabout.com), by the team at [New_ Public](https://newpublic.org). New_ Public is a nonprofit working on healthier digital public spaces. We're open-sourcing ALF as a demonstration of scheduled posting and draft infrastructure that is reusable across the atproto ecosystem.

## License

Apache 2.0
