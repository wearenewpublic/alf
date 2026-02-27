# ALF Demo — Scheduled Bluesky Posts

A self-contained demo application that shows how to integrate with [ALF (ATProto Latency Fabric)](../README.md) to schedule posts on Bluesky from your own app.

## What this demo shows

- Authenticating a user with their Bluesky account via ATProto OAuth (loopback client pattern)
- Authorizing ALF to post on the user's behalf via a second OAuth flow
- Scheduling a Bluesky post with a future `scheduledAt` time
- Listing, publishing immediately, and cancelling scheduled drafts
- Using ALF's DPoP-authenticated XRPC proxy endpoints from a Node.js server

## Prerequisites

- Node.js 20 or later
- ALF running locally (see ALF setup below)

## Setup

1. Copy the example environment file and edit it:

   ```sh
   cp .env.example .env
   ```

   Set `ALF_URL` to the address where your local ALF instance is running (default: `http://localhost:1986`).

2. Install dependencies:

   ```sh
   npm install
   ```

## Running ALF locally

See the [ALF README](../README.md) for full setup instructions. The short version:

```sh
# In the ALF root directory
cp .env.example .env
# Edit .env — set ENCRYPTION_KEY (generate with the command in the file)
# Optionally set OAUTH_SUCCESS_REDIRECT=http://localhost:1756 for seamless UX
npm install
npm run dev
```

ALF will start on port 1986 by default (configurable via `ALF_PORT`).

## Running the demo

```sh
npm run dev
```

The demo server starts on port 1756 (configurable via `PORT` in `.env`). Open [http://localhost:1756](http://localhost:1756) in your browser.

## Demo flow, step by step

1. **Sign in** — Enter your ATProto handle (e.g. `alice.bsky.social`) and click "Sign in with Bluesky". The demo server calls ALF's OAuth client to get an authorization URL, then redirects your browser to your PDS (Bluesky's auth page).

2. **Complete Bluesky sign-in** — Your browser completes the OAuth flow with your PDS and is redirected back to the demo's `/oauth/callback`. The demo stores your session in memory and sets a session cookie.

3. **Authorize ALF** — After sign-in, if ALF has not yet been granted permission to post on your behalf, you will see the "Authorize ALF" screen. Click the button to start a second OAuth flow — this time authorizing ALF itself. You'll be redirected to your PDS again.

4. **Return to the demo** — After authorizing ALF, your PDS redirects to ALF's callback. If `OAUTH_SUCCESS_REDIRECT` is set in ALF's environment (see below), ALF will redirect you back to the demo automatically. Otherwise, navigate back manually.

5. **Schedule a post** — Type your post text, optionally pick a future date and time, and click "Schedule Post". The demo proxies the request through ALF, which stores it as a draft.

6. **Manage drafts** — The "Scheduled Drafts" section refreshes every 5 seconds and shows all your drafts with their status. You can publish a draft immediately with "Publish Now" or remove it with "Cancel".

## OAUTH_SUCCESS_REDIRECT

When a user completes the ALF OAuth authorization flow, ALF's callback normally returns a JSON response. Setting `OAUTH_SUCCESS_REDIRECT` in ALF's `.env` causes ALF to instead redirect the browser back to your app with the authorized DID as a query parameter:

```
http://localhost:1756?did=did%3Aplc%3A...
```

This makes the authorization flow seamless — the user is returned to your app automatically after authorizing ALF, rather than seeing a raw JSON success message.

To enable this, add the following to ALF's `.env`:

```
OAUTH_SUCCESS_REDIRECT=http://localhost:1756
```

The demo will display a brief "ALF authorized successfully!" banner when it detects the `?authorized=true` query parameter on the return redirect (the demo's own OAuth callback sets this).
