// ABOUTME: ATProto OAuth client setup with DB-backed state and session stores

import {
  NodeOAuthClient,
  type NodeSavedState,
  type NodeSavedStateStore,
  type NodeSavedSession,
  type NodeSavedSessionStore,
  type OAuthClientOptions,
} from '@atproto/oauth-client-node';
import type { ServiceConfig } from './config.js';
import { createLogger } from './logger.js';
import {
  saveOAuthState,
  getOAuthState,
  deleteOAuthState,
  upsertUserAuthorization,
  getUserAuthorization,
} from './storage.js';
import { encrypt, decrypt } from './encrypt.js';

const logger = createLogger('OAuth');

/**
 * DB-backed state store for OAuth PKCE flow
 */
function createStateStore(): NodeSavedStateStore {
  return {
    async get(key: string): Promise<NodeSavedState | undefined> {
      const data = await getOAuthState(key);
      if (!data) return undefined;
      return data as NodeSavedState;
    },
    async set(key: string, value: NodeSavedState): Promise<void> {
      await saveOAuthState(key, value as object);
    },
    async del(key: string): Promise<void> {
      await deleteOAuthState(key);
    },
  };
}

/**
 * DB-backed session store for OAuth tokens
 */
function createSessionStore(encryptionKey: string): NodeSavedSessionStore {
  return {
    async get(sub: string): Promise<NodeSavedSession | undefined> {
      const row = await getUserAuthorization(sub);
      if (!row) return undefined;

      try {
        const refreshToken = decrypt(row.refresh_token, encryptionKey);
        const dpopBlob = JSON.parse(decrypt(row.dpop_private_key, encryptionKey)) as
          | { jwk: Record<string, unknown>; aud: string; access_token?: string; expires_at?: number | string }
          | Record<string, unknown>;

        // New format: { jwk, aud, access_token?, expires_at? }. Legacy format: bare JWK object.
        const dpopJwk = 'jwk' in dpopBlob ? dpopBlob.jwk : dpopBlob;
        const aud = ('aud' in dpopBlob && typeof dpopBlob.aud === 'string' && dpopBlob.aud)
          ? dpopBlob.aud
          : row.pds_url;
        const accessToken = ('access_token' in dpopBlob && typeof dpopBlob.access_token === 'string' && dpopBlob.access_token)
          ? dpopBlob.access_token
          : undefined;
        // SDK stores expires_at as an ISO date string (toISOString()), but legacy code stored it as
        // a Unix ms number. Accept both formats so isStale() can detect stale sessions.
        const expiresAtRaw = 'expires_at' in dpopBlob ? dpopBlob.expires_at : undefined;
        const expiresAt = typeof expiresAtRaw === 'number'
          ? expiresAtRaw
          : typeof expiresAtRaw === 'string' && expiresAtRaw
            ? new Date(expiresAtRaw).getTime()
            : undefined;

        // If we have no stored access_token, force the SDK to refresh immediately
        // by returning expires_at=0 (epoch). Without this the SDK considers the
        // session "not stale" (no expires_at = never stale) and tries to use an
        // undefined access_token, producing "Authorization: DPoP undefined" which
        // the PDS rejects as "Malformed token".
        const effectiveExpiresAt = accessToken ? expiresAt : 0;

        return {
          dpopJwk: dpopJwk as Record<string, unknown>,
          authMethod: { method: 'none' },
          tokenSet: {
            sub,
            iss: row.pds_url,  // authorization server (e.g. https://bsky.social)
            aud,               // resource server / PDS (e.g. https://morel.us-east.host.bsky.network)
            scope: row.token_scope,
            refresh_token: refreshToken,
            access_token: accessToken,
            expires_at: effectiveExpiresAt,
            token_type: 'DPoP',
          },
        } as NodeSavedSession;
      } catch (err) {
        logger.error('Failed to decrypt OAuth session', err as Error, { sub });
        return undefined;
      }
    },

    async set(sub: string, value: NodeSavedSession): Promise<void> {
      logger.info('OAuth session set for user', { sub });
      const dpopJwk = value.dpopJwk;
      const tokenSet = value.tokenSet;

      const encryptedRefreshToken = encrypt(
        tokenSet.refresh_token ?? '',
        encryptionKey,
      );
      // Store aud alongside the JWK so we can restore it in get().
      // Also store the access_token and expires_at so the SDK can use it
      // directly on restore without always doing a fresh token exchange.
      // iss (authorization server) and aud (resource server / PDS) differ for
      // hosted PDSes like bsky.social where the entryway issues tokens for a
      // separate PDS host.
      const encryptedDpopKey = encrypt(
        JSON.stringify({
          jwk: dpopJwk,
          aud: typeof tokenSet.aud === 'string' ? tokenSet.aud : '',
          access_token: tokenSet.access_token ?? '',
          expires_at: tokenSet.expires_at ?? null,
        }),
        encryptionKey,
      );

      await upsertUserAuthorization({
        userDid: sub,
        pdsUrl: typeof tokenSet.iss === 'string' ? tokenSet.iss : '',
        refreshToken: encryptedRefreshToken,
        dpopPrivateKey: encryptedDpopKey,
        tokenScope: typeof tokenSet.scope === 'string' ? tokenSet.scope : '',
      });
      logger.info('OAuth authorization stored for user', { sub });
    },

    del(sub: string): void {
      // We don't delete the authorization record, just mark it as revoked
      // by clearing the tokens. In practice, user can re-authorize.
      logger.info('OAuth session deleted for user', { sub });
    },
  };
}

let oauthClient: NodeOAuthClient | null = null;

/**
 * Initialize the OAuth client with DB-backed stores.
 * Uses loopback client pattern for HTTP (dev) and discoverable for HTTPS (prod).
 */
export function createOAuthClient(config: ServiceConfig): NodeOAuthClient {
  const isHttps = config.serviceUrl.startsWith('https://');
  const scope = config.oauthScope;

  // RFC 8252: loopback client pattern for HTTP (dev), discoverable for HTTPS (prod)
  let clientMetadata: OAuthClientOptions['clientMetadata'];
  if (isHttps) {
    clientMetadata = {
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
    };
  } else {
    // Loopback client per RFC 8252: scope and redirect_uri are encoded in the client_id URL
    // so the PDS can determine allowed scopes/redirects without fetching external metadata.
    const port = new URL(config.serviceUrl).port;
    const redirectUri = `http://127.0.0.1${port ? `:${port}` : ''}/oauth/callback`;
    const loopbackParams = new URLSearchParams({
      scope,
      redirect_uri: redirectUri,
    });
    clientMetadata = {
      client_id: `http://localhost?${loopbackParams.toString()}`,
      client_name: 'Scheduled Posts',
      redirect_uris: [redirectUri],
      scope,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      dpop_bound_access_tokens: true,
      application_type: 'native',
    };
  }

  const client = new NodeOAuthClient({
    clientMetadata,
    stateStore: createStateStore(),
    sessionStore: createSessionStore(config.encryptionKey),
    handleResolver: config.handleResolverUrl,
    plcDirectoryUrl: config.plcRoot,
    allowHttp: !isHttps,
  });

  return client;
}

export function setOAuthClient(client: NodeOAuthClient): void {
  oauthClient = client;
}

export function getOAuthClient(): NodeOAuthClient {
  if (!oauthClient) throw new Error('OAuth client not initialized');
  return oauthClient;
}
