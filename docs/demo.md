# Running the Demo App

The `demo/` directory contains a standalone web application that demonstrates scheduled posting with ALF. It shows the full integration: OAuth sign-in, authorizing ALF, creating scheduled posts with images, and managing drafts through ALF's XRPC endpoints.

## What the demo shows

- Authenticating a Bluesky user via ATProto OAuth (loopback client pattern, all in the browser)
- Authorizing ALF to post on the user's behalf via a second OAuth flow
- Scheduling a Bluesky post with a custom or preset publish time
- Attaching an image to a scheduled post (upload to ALF's `/blob` endpoint, referenced in the record)
- Listing all drafts with live status updates (polling every 5 seconds)
- Editing the text or schedule time of a pending draft
- Publishing a draft immediately or deleting it

The demo is a two-panel web UI: the left panel is the interactive scheduling interface; the right panel shows an architecture overview explaining how the proxy works.

## Architecture

The demo is a minimal Express server (`demo/server.ts`) that serves static files and exposes a single `/api/config` endpoint. All OAuth logic and API calls run entirely in the browser (`demo/client/index.ts`) using `@atproto/oauth-client-browser`. The browser talks directly to ALF — the demo server itself never proxies API requests.

```
Browser (demo/client/index.ts)
  └─ OAuth login → your PDS
  └─ OAuth authorize ALF → your PDS → ALF callback
  └─ XRPC writes + reads → ALF (ALF_URL)
       └─ publishes to PDS at scheduled time

Demo server (demo/server.ts)
  └─ Serves static files
  └─ GET /api/config → { alfUrl }
```

## Prerequisites

- Node.js 20 or later
- ALF running locally (see below)

## Step 1: Start ALF

The demo is a client for ALF — ALF must be running before you open the demo in your browser.

See the [Quick Start in the main README](../README.md#quick-start) for full instructions. The short version:

```sh
# In the ALF root directory
cp .env.example .env
# Edit .env and set ENCRYPTION_KEY (generate one with the command in the file)

# Optional but recommended: set this so the demo's OAuth flow returns you
# to the demo automatically after you authorize ALF
echo 'OAUTH_SUCCESS_REDIRECT=http://localhost:1756' >> .env

npm install
npm run dev
```

ALF starts on port 1986 by default (configurable with `ALF_PORT`).

## Step 2: Start the demo

```sh
cd demo
npm install
cp .env.example .env
# Edit .env if needed (see env vars below)
npm run dev
```

The demo server starts on port 1756. Open [http://localhost:1756](http://localhost:1756) in your browser.

`npm run dev` builds the client bundle with esbuild and then starts the Express server with `ts-node`.

## Environment variables

Both files live in `demo/.env` (copied from `demo/.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `ALF_URL` | `http://localhost:1986` | URL of the running ALF instance |
| `PORT` | `1756` | Port the demo server listens on |

The demo server exposes `ALF_URL` to the browser via `/api/config`, so the client-side code knows where to send XRPC requests.

## Demo flow

1. **Sign in** — Enter your ATProto handle (e.g. `alice.bsky.social`) and click "Sign in". The browser starts an ATProto OAuth flow and redirects you to your PDS to approve.

2. **Authorize ALF** — After sign-in, if ALF does not yet have a stored session for your account, you will see the "Grant access" screen. Click the button. Your browser is redirected to your PDS again, this time to authorize ALF to publish on your behalf.

3. **Return to the demo** — After authorizing ALF, your PDS redirects to ALF's callback. If `OAUTH_SUCCESS_REDIRECT` is set in ALF's `.env` (recommended), ALF redirects you back to the demo automatically and a brief "Authorized" banner appears. Otherwise you need to navigate back manually.

4. **Schedule a post** — Type your post text, optionally attach an image, pick a schedule time (preset buttons: +90s, +1 hr, Tomorrow 9am, Next week, or set a custom datetime), and click "Schedule Post". The browser uploads any image directly to ALF's `/blob` endpoint, then sends an XRPC `createRecord` call with the `x-scheduled-at` header.

5. **Manage drafts** — The "Drafts" section updates every 5 seconds. Each draft shows its status (draft, scheduled, published, failed). You can edit the text or schedule time, publish immediately, or delete.

## OAUTH_SUCCESS_REDIRECT

When a user completes the ALF OAuth authorization flow, ALF's callback normally returns a JSON response. Setting `OAUTH_SUCCESS_REDIRECT` in ALF's `.env` causes ALF to redirect the browser to your app instead, with the authorized DID as a query parameter:

```
http://localhost:1756?did=did%3Aplc%3A...
```

This makes the flow seamless — the user lands back in the demo automatically. Without it, the user sees a JSON response from ALF and must navigate back by hand.

To enable:

```sh
# In ALF's .env
OAUTH_SUCCESS_REDIRECT=http://localhost:1756
```
