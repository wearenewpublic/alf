// ABOUTME: OAuth routes for ATProto OAuth delegation flow

import crypto from 'crypto';
import { Router } from 'express';
import type { ServiceConfig } from '../config.js';
import { getOAuthClient } from '../oauth.js';
import { createLogger } from '../logger.js';

const logger = createLogger('OAuthRoutes');

// Short-lived map from OAuth state value → app redirect_uri.
// Entries are populated when /authorize is called with a redirect_uri param
// and consumed (deleted) when the matching /callback fires.
const pendingRedirects = new Map<string, string>();

export function createOAuthRouter(config: ServiceConfig): Router {
  const router = Router();

  /**
   * OAuth client metadata document (ATProto client registration)
   * PDSes use this to discover client capabilities
   */
  const scope = `atproto repo:${config.allowedCollections}?action=create blob:*/*`;

  router.get('/client-metadata.json', (_req, res) => {
    res.json({
      client_id: `${config.serviceUrl}/oauth/client-metadata.json`,
      client_name: 'Scheduled Posts',
      client_uri: config.serviceUrl,
      redirect_uris: [`${config.serviceUrl}/oauth/callback`],
      scope,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      dpop_bound_access_tokens: true,
      application_type: 'web',
    });
  });

  /**
   * Initiate the OAuth flow - redirect to user's PDS authorization page
   */
  router.get('/authorize', async (req, res) => {
    const handle = req.query.handle as string | undefined;
    const redirectUri = req.query.redirect_uri as string | undefined;

    if (!handle) {
      res.status(400).json({ error: 'handle parameter is required' });
      return;
    }

    if (redirectUri) {
      let parsed: URL;
      try {
        parsed = new URL(redirectUri);
      } catch {
        res.status(400).json({ error: 'redirect_uri is not a valid URL' });
        return;
      }
      const isProd = config.serviceUrl.startsWith('https://');
      const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      if (isProd && parsed.protocol !== 'https:' && !isLoopback) {
        res.status(400).json({ error: 'redirect_uri must use HTTPS in production' });
        return;
      }
    }

    try {
      const oauthClient = getOAuthClient();

      // Generate a short random key and stash the redirect_uri in the pending
      // map. Pass the key as the OAuth `state` so the client library threads
      // it through the PAR/PKCE flow and returns it in callback result.state.
      let stateKey: string | undefined;
      if (redirectUri) {
        stateKey = crypto.randomUUID();
        pendingRedirects.set(stateKey, redirectUri);
      }

      const url = await oauthClient.authorize(handle, {
        scope,
        ...(stateKey ? { state: stateKey } : {}),
      });

      logger.info('Redirecting to PDS authorization', { handle });
      res.redirect(url.toString());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('OAuth authorization failed', err instanceof Error ? err : undefined, { handle });
      res.status(500).json({ error: 'Authorization failed', message });
    }
  });

  /**
   * Handle OAuth callback from PDS
   * Exchanges authorization code for tokens and stores them
   */
  router.get('/callback', async (req, res) => {
    const params = req.query as Record<string, string>;

    if (!params.code) {
      res.status(400).json({ error: 'Missing authorization code' });
      return;
    }

    try {
      const oauthClient = getOAuthClient();
      const result = await oauthClient.callback(new URLSearchParams(params));

      const sub = result.session.sub;
      logger.info('OAuth flow completed successfully', { sub });

      const appRedirectUri = result.state ? pendingRedirects.get(result.state) : undefined;
      if (appRedirectUri) {
        pendingRedirects.delete(result.state!);
        const redirectUrl = `${appRedirectUri}?did=${encodeURIComponent(sub)}`;
        logger.info('Redirecting to app redirect_uri', { redirectUrl });
        res.redirect(redirectUrl);
        return;
      }

      res.json({
        success: true,
        did: sub,
        message: 'Authorization successful. You can now use the scheduled posts service.',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('OAuth callback failed', err instanceof Error ? err : undefined);
      res.status(500).json({ error: 'Authorization callback failed', message });
    }
  });

  return router;
}
