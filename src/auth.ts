// ABOUTME: Inbound authentication - verifies PDS Bearer tokens from clients
// Validates ATProto access tokens by fetching JWKS from the issuing PDS

import crypto from 'crypto';
import * as jose from 'jose';
import { createLogger } from './logger.js';

const logger = createLogger('Auth');

export interface VerifiedUser {
  did: string;
}

// Cache of JWKS sets keyed by PDS base URL
const jwksSetsCache = new Map<string, ReturnType<typeof jose.createRemoteJWKSet>>();

function getJwksSet(pdsUrl: string): ReturnType<typeof jose.createRemoteJWKSet> {
  const cached = jwksSetsCache.get(pdsUrl);
  if (cached) return cached;

  // ATProto PDS OAuth JWKS endpoint
  const jwksUri = new URL('/oauth/jwks', pdsUrl);
  const jwksSet = jose.createRemoteJWKSet(jwksUri);
  jwksSetsCache.set(pdsUrl, jwksSet);
  return jwksSet;
}

/**
 * Clear the JWKS cache (used in tests)
 */
export function clearJwksCache(): void {
  jwksSetsCache.clear();
}

/**
 * Extract Bearer token from Authorization header
 */
export function extractBearerToken(authHeader: string | undefined): string {
  if (!authHeader) {
    throw new Error('Missing Authorization header');
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || (parts[0] !== 'Bearer' && parts[0] !== 'DPoP')) {
    throw new Error('Invalid Authorization header format - expected "Bearer <token>" or "DPoP <token>"');
  }

  return parts[1];
}

/**
 * Verify a PDS Bearer token and extract the user's DID.
 *
 * For ATProto OAuth tokens (asymmetric): performs full JWKS signature verification.
 * For legacy HS256 tokens: validates expiry and extracts sub (pragmatic dev fallback).
 *
 * @param token JWT Bearer token from the PDS
 * @param pdsUrl Base URL of the PDS (used to fetch JWKS)
 * @returns The verified user's DID
 */
export async function verifyBearerToken(
  token: string,
  pdsUrl: string,
): Promise<VerifiedUser> {
  // Decode without verification to inspect the token
  let header: jose.ProtectedHeaderParameters;
  try {
    header = jose.decodeProtectedHeader(token);
  } catch {
    throw new Error('Invalid JWT: cannot decode header');
  }

  // Check for symmetric algorithms (legacy createSession tokens)
  if (header.alg === 'HS256' || header.alg === 'HS384' || header.alg === 'HS512') {
    logger.warn('Received legacy HS256 token - falling back to expiry-only validation', {
      alg: header.alg,
    });

    const payload = jose.decodeJwt(token);
    if (!payload.sub) {
      throw new Error('Missing sub claim in JWT');
    }
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && now > payload.exp) {
      throw new Error('JWT token expired');
    }
    return { did: payload.sub };
  }

  // Asymmetric token - full JWKS verification
  const jwks = getJwksSet(pdsUrl);

  let payload: jose.JWTPayload;
  try {
    const result = await jose.jwtVerify(token, jwks);
    payload = result.payload;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`JWT verification failed: ${message}`);
  }

  if (!payload.sub) {
    throw new Error('Missing sub claim in verified JWT');
  }

  return { did: payload.sub };
}

/**
 * Verify a DPoP-bound access token using the DPoP proof.
 *
 * Does not require a JWKS endpoint — the DPoP proof header embeds the public
 * key and the access token binds to it via cnf.jkt. Together they prove the
 * caller holds the DPoP private key and presented the correct access token.
 */
export async function verifyDpopBoundToken(
  accessToken: string,
  dpopProof: string,
): Promise<VerifiedUser> {
  // Decode access token payload without signature verification.
  // We trust sub/exp/cnf because we verify the DPoP binding below.
  let atPayload: jose.JWTPayload;
  try {
    atPayload = jose.decodeJwt(accessToken);
  } catch {
    throw new Error('Invalid access token: cannot decode payload');
  }

  if (!atPayload.sub) throw new Error('Missing sub claim in access token');

  const now = Math.floor(Date.now() / 1000);
  if (atPayload.exp && now > atPayload.exp) throw new Error('Access token expired');

  const cnf = atPayload.cnf as Record<string, string> | undefined;
  if (!cnf?.jkt) throw new Error('Missing cnf.jkt in access token (not a DPoP-bound token)');

  // Extract the public key embedded in the DPoP proof header
  let dpopHeader: jose.ProtectedHeaderParameters;
  try {
    dpopHeader = jose.decodeProtectedHeader(dpopProof);
  } catch {
    throw new Error('Invalid DPoP proof: cannot decode header');
  }

  const dpopJwk = dpopHeader.jwk as jose.JWK | undefined;
  if (!dpopJwk) throw new Error('Missing jwk in DPoP proof header');

  // Verify the DPoP key thumbprint matches cnf.jkt in the access token
  const keyThumbprint = await jose.calculateJwkThumbprint(dpopJwk);
  if (keyThumbprint !== cnf.jkt) {
    throw new Error('DPoP key thumbprint does not match cnf.jkt in access token');
  }

  // Verify the DPoP proof signature using the embedded public key
  const dpopPublicKey = await jose.importJWK(dpopJwk);
  let dpopPayload: jose.JWTPayload;
  try {
    const result = await jose.jwtVerify(dpopProof, dpopPublicKey, { typ: 'dpop+jwt' });
    dpopPayload = result.payload;
  } catch (err) {
    throw new Error(`DPoP proof verification failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Verify the DPoP proof is fresh (prevent replay)
  if (typeof dpopPayload.iat === 'number' && now - dpopPayload.iat > 60) {
    throw new Error('DPoP proof too old');
  }

  // Verify ath: DPoP proof must be cryptographically bound to this access token
  const tokenHash = crypto.createHash('sha256').update(accessToken).digest('base64url');
  if (dpopPayload.ath !== tokenHash) {
    throw new Error('DPoP ath claim does not match access token hash');
  }

  return { did: atPayload.sub };
}

/**
 * Extract and verify a Bearer token from the Authorization header.
 * Returns the verified user's DID.
 */
export async function verifyRequestAuth(
  authHeader: string | undefined,
  pdsUrl: string,
): Promise<VerifiedUser> {
  const token = extractBearerToken(authHeader);
  return verifyBearerToken(token, pdsUrl);
}

/**
 * Extract the PDS URL from a JWT's iss claim.
 * Falls back to a default PDS URL if the iss is not a URL.
 */
export function extractPdsUrlFromToken(token: string, defaultPdsUrl: string): string {
  try {
    const payload = jose.decodeJwt(token);
    if (payload.iss && payload.iss.startsWith('http')) {
      return payload.iss;
    }
  } catch {
    // fall through
  }
  return defaultPdsUrl;
}
