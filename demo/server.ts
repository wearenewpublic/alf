// ABOUTME: Minimal static file server for the ALF demo. All OAuth and API
// logic runs in the browser. This server only serves static files and
// exposes a single /api/config endpoint.

import * as dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import path from 'path';

const ALF_URL = process.env.ALF_URL || 'http://localhost:1986';
const SERVICE_URL = process.env.SERVICE_URL || 'http://localhost:1756';
const PORT = parseInt(process.env.PORT || '1756', 10);

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/config', (_req, res) => res.json({ alfUrl: ALF_URL, serviceUrl: SERVICE_URL }));
// OAuth client metadata for deployed (non-loopback) environments
app.get('/oauth/client-metadata.json', (_req, res) => {
  res.json({
    client_id: `${SERVICE_URL}/oauth/client-metadata.json`,
    client_name: 'ALF Demo',
    client_uri: SERVICE_URL,
    redirect_uris: [`${SERVICE_URL}/`],
    scope: 'atproto transition:generic',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    dpop_bound_access_tokens: true,
    application_type: 'web',
  });
});
// SPA fallback
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`ALF Demo running at http://localhost:${PORT}`);
  console.log(`ALF backend: ${ALF_URL}`);
});
