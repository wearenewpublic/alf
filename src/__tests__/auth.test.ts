// Tests for Bearer token authentication

import { createHash } from 'node:crypto';
import * as jose from 'jose';
import {
  extractBearerToken,
  verifyBearerToken,
  verifyRequestAuth,
  extractPdsUrlFromToken,
  clearJwksCache,
  verifyDpopBoundToken,
} from '../auth';

// Mock jose module
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
  decodeProtectedHeader: jest.fn(),
  decodeJwt: jest.fn(),
  calculateJwkThumbprint: jest.fn(),
  importJWK: jest.fn(),
}));

const mockJose = jose as jest.Mocked<typeof jose>;

describe('auth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearJwksCache();
  });

  describe('extractBearerToken', () => {
    it('should extract token from valid Bearer header', () => {
      expect(extractBearerToken('Bearer my-token')).toBe('my-token');
    });

    it('should throw on missing header', () => {
      expect(() => extractBearerToken(undefined)).toThrow('Missing Authorization header');
    });

    it('should throw on invalid format', () => {
      expect(() => extractBearerToken('Basic abc123')).toThrow('Invalid Authorization header format');
    });

    it('should throw on malformed header', () => {
      expect(() => extractBearerToken('Bearer')).toThrow('Invalid Authorization header format');
    });

    it('should extract token from DPoP header', () => {
      expect(extractBearerToken('DPoP my-dpop-token')).toBe('my-dpop-token');
    });
  });

  describe('verifyBearerToken', () => {
    const pdsUrl = 'https://pds.example.com';

    it('should verify asymmetric token with JWKS', async () => {
      const mockJwksSet = jest.fn();
      mockJose.createRemoteJWKSet.mockReturnValue(mockJwksSet as unknown as ReturnType<typeof jose.createRemoteJWKSet>);
      mockJose.decodeProtectedHeader.mockReturnValue({ alg: 'ES256' } as jose.ProtectedHeaderParameters);
      mockJose.jwtVerify.mockResolvedValue({
        payload: { sub: 'did:plc:alice123', iss: pdsUrl, iat: 1000, exp: 9999999999 },
        protectedHeader: { alg: 'ES256' },
      } as unknown as jose.JWTVerifyResult);

      const result = await verifyBearerToken('valid.jwt.token', pdsUrl);

      expect(result).toEqual({ did: 'did:plc:alice123' });
      expect(mockJose.createRemoteJWKSet).toHaveBeenCalledWith(
        new URL('/oauth/jwks', pdsUrl),
      );
    });

    it('should cache JWKS set for the same PDS URL', async () => {
      const mockJwksSet = jest.fn();
      mockJose.createRemoteJWKSet.mockReturnValue(mockJwksSet as unknown as ReturnType<typeof jose.createRemoteJWKSet>);
      mockJose.decodeProtectedHeader.mockReturnValue({ alg: 'ES256' } as jose.ProtectedHeaderParameters);
      mockJose.jwtVerify.mockResolvedValue({
        payload: { sub: 'did:plc:alice123' },
        protectedHeader: { alg: 'ES256' },
      } as unknown as jose.JWTVerifyResult);

      await verifyBearerToken('token1', pdsUrl);
      await verifyBearerToken('token2', pdsUrl);

      // createRemoteJWKSet should only be called once per PDS URL
      expect(mockJose.createRemoteJWKSet).toHaveBeenCalledTimes(1);
    });

    it('should throw on expired token', async () => {
      const mockJwksSet = jest.fn();
      mockJose.createRemoteJWKSet.mockReturnValue(mockJwksSet as unknown as ReturnType<typeof jose.createRemoteJWKSet>);
      mockJose.decodeProtectedHeader.mockReturnValue({ alg: 'ES256' } as jose.ProtectedHeaderParameters);
      mockJose.jwtVerify.mockRejectedValue(new Error('JWT expired'));

      await expect(verifyBearerToken('expired.jwt', pdsUrl)).rejects.toThrow(
        'JWT verification failed: JWT expired',
      );
    });

    it('should handle HS256 tokens with fallback to expiry check', async () => {
      mockJose.decodeProtectedHeader.mockReturnValue({ alg: 'HS256' } as jose.ProtectedHeaderParameters);
      mockJose.decodeJwt.mockReturnValue({
        sub: 'did:plc:bob456',
        exp: 9999999999,
        iss: 'https://pds.example.com',
        aud: 'did:plc:service',
        iat: 1000,
      });

      const result = await verifyBearerToken('legacy.hs256.token', pdsUrl);

      expect(result).toEqual({ did: 'did:plc:bob456' });
      // Should NOT call createRemoteJWKSet for HS256
      expect(mockJose.createRemoteJWKSet).not.toHaveBeenCalled();
    });

    it('should throw on HS256 token with missing sub', async () => {
      mockJose.decodeProtectedHeader.mockReturnValue({ alg: 'HS256' } as jose.ProtectedHeaderParameters);
      mockJose.decodeJwt.mockReturnValue({
        exp: 9999999999,
        iss: 'https://pds.example.com',
        aud: 'did:plc:service',
        iat: 1000,
      });

      await expect(verifyBearerToken('legacy.no.sub', pdsUrl)).rejects.toThrow(
        'Missing sub claim in JWT',
      );
    });

    it('should throw on HS256 token that is expired', async () => {
      mockJose.decodeProtectedHeader.mockReturnValue({ alg: 'HS256' } as jose.ProtectedHeaderParameters);
      mockJose.decodeJwt.mockReturnValue({
        sub: 'did:plc:alice123',
        exp: 1, // expired long ago
        iss: 'https://pds.example.com',
        aud: 'did:plc:service',
        iat: 0,
      });

      await expect(verifyBearerToken('expired.hs256.token', pdsUrl)).rejects.toThrow(
        'JWT token expired',
      );
    });

    it('should throw on invalid JWT that cannot be decoded', async () => {
      mockJose.decodeProtectedHeader.mockImplementation(() => {
        throw new Error('Invalid JWT');
      });

      await expect(verifyBearerToken('not.a.jwt', pdsUrl)).rejects.toThrow(
        'Invalid JWT: cannot decode header',
      );
    });

    it('should handle non-Error rejection from jwtVerify', async () => {
      const mockJwksSet = jest.fn();
      mockJose.createRemoteJWKSet.mockReturnValue(mockJwksSet as unknown as ReturnType<typeof jose.createRemoteJWKSet>);
      mockJose.decodeProtectedHeader.mockReturnValue({ alg: 'ES256' } as jose.ProtectedHeaderParameters);
      mockJose.jwtVerify.mockRejectedValue('string rejection');

      await expect(verifyBearerToken('some.jwt', pdsUrl)).rejects.toThrow(
        'JWT verification failed: string rejection',
      );
    });

    it('should throw on missing sub claim in asymmetric token', async () => {
      const mockJwksSet = jest.fn();
      mockJose.createRemoteJWKSet.mockReturnValue(mockJwksSet as unknown as ReturnType<typeof jose.createRemoteJWKSet>);
      mockJose.decodeProtectedHeader.mockReturnValue({ alg: 'ES256' } as jose.ProtectedHeaderParameters);
      mockJose.jwtVerify.mockResolvedValue({
        payload: { iss: pdsUrl }, // no sub
        protectedHeader: { alg: 'ES256' },
      } as unknown as jose.JWTVerifyResult);

      await expect(verifyBearerToken('token.no.sub', pdsUrl)).rejects.toThrow(
        'Missing sub claim in verified JWT',
      );
    });
  });

  describe('extractPdsUrlFromToken', () => {
    it('should extract PDS URL from iss claim', () => {
      mockJose.decodeJwt.mockReturnValue({
        iss: 'https://pds.alice.example',
        sub: 'did:plc:alice',
        aud: 'did:plc:service',
        exp: 9999999999,
        iat: 1000,
      });

      const result = extractPdsUrlFromToken('valid.jwt.token', 'https://default.pds');
      expect(result).toBe('https://pds.alice.example');
    });

    it('should return default URL when iss is not a URL', () => {
      mockJose.decodeJwt.mockReturnValue({
        iss: 'did:plc:pds123', // DID, not URL
        sub: 'did:plc:alice',
        aud: 'did:plc:service',
        exp: 9999999999,
        iat: 1000,
      });

      const result = extractPdsUrlFromToken('token', 'https://default.pds');
      expect(result).toBe('https://default.pds');
    });

    it('should return default URL when token cannot be decoded', () => {
      mockJose.decodeJwt.mockImplementation(() => {
        throw new Error('decode error');
      });

      const result = extractPdsUrlFromToken('bad-token', 'https://default.pds');
      expect(result).toBe('https://default.pds');
    });
  });

  describe('verifyRequestAuth', () => {
    it('extracts token and delegates to verifyBearerToken', async () => {
      mockJose.decodeProtectedHeader.mockReturnValue({ alg: 'ES256' } as jose.ProtectedHeaderParameters);
      const mockJwksSet = jest.fn();
      mockJose.createRemoteJWKSet.mockReturnValue(mockJwksSet as unknown as ReturnType<typeof jose.createRemoteJWKSet>);
      mockJose.jwtVerify.mockResolvedValue({
        payload: { sub: 'did:plc:authtest', iss: 'https://pds.example.com' },
        protectedHeader: { alg: 'ES256' },
      } as unknown as jose.JWTVerifyResult);

      const result = await verifyRequestAuth('Bearer some-token', 'https://pds.example.com');
      expect(result).toEqual({ did: 'did:plc:authtest' });
    });
  });

  describe('verifyDpopBoundToken', () => {
    const accessToken = 'header.payload.sig';
    const dpopProof = 'dpop.proof.sig';
    const mockJwk = { kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' };
    const mockDid = 'did:plc:alice123';

    // Build a consistent ath for the mock access token
    const validAth = createHash('sha256').update(accessToken).digest('base64url');

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should verify a valid DPoP-bound token', async () => {
      mockJose.decodeJwt.mockReturnValue({
        sub: mockDid,
        exp: 9999999999,
        cnf: { jkt: 'valid-thumbprint' },
      });
      mockJose.decodeProtectedHeader.mockReturnValue({
        alg: 'ES256',
        jwk: mockJwk,
      } as unknown as jose.ProtectedHeaderParameters);
      (mockJose.calculateJwkThumbprint as jest.Mock).mockResolvedValue('valid-thumbprint');
      const mockPublicKey = {};
      (mockJose.importJWK as jest.Mock).mockResolvedValue(mockPublicKey);
      mockJose.jwtVerify.mockResolvedValue({
        payload: {
          iat: Math.floor(Date.now() / 1000),
          ath: validAth,
          htm: 'GET',
          htu: 'http://localhost:1986/oauth/status',
        },
        protectedHeader: { alg: 'ES256' },
      } as unknown as jose.JWTVerifyResult);

      const result = await verifyDpopBoundToken(accessToken, dpopProof);
      expect(result).toEqual({ did: mockDid });
    });

    it('should throw when access token has no sub', async () => {
      mockJose.decodeJwt.mockReturnValue({ exp: 9999999999, cnf: { jkt: 'x' } });
      await expect(verifyDpopBoundToken(accessToken, dpopProof)).rejects.toThrow('Missing sub claim');
    });

    it('should throw when access token is expired', async () => {
      mockJose.decodeJwt.mockReturnValue({ sub: mockDid, exp: 1, cnf: { jkt: 'x' } });
      await expect(verifyDpopBoundToken(accessToken, dpopProof)).rejects.toThrow('Access token expired');
    });

    it('should throw when cnf.jkt is missing', async () => {
      mockJose.decodeJwt.mockReturnValue({ sub: mockDid, exp: 9999999999 });
      await expect(verifyDpopBoundToken(accessToken, dpopProof)).rejects.toThrow('Missing cnf.jkt');
    });

    it('should throw when DPoP proof header cannot be decoded', async () => {
      mockJose.decodeJwt.mockReturnValue({ sub: mockDid, exp: 9999999999, cnf: { jkt: 'x' } });
      mockJose.decodeProtectedHeader.mockImplementation(() => { throw new Error('bad header'); });
      await expect(verifyDpopBoundToken(accessToken, dpopProof)).rejects.toThrow('Invalid DPoP proof: cannot decode header');
    });

    it('should throw when DPoP proof header has no jwk', async () => {
      mockJose.decodeJwt.mockReturnValue({ sub: mockDid, exp: 9999999999, cnf: { jkt: 'x' } });
      mockJose.decodeProtectedHeader.mockReturnValue({ alg: 'ES256' } as jose.ProtectedHeaderParameters);
      await expect(verifyDpopBoundToken(accessToken, dpopProof)).rejects.toThrow('Missing jwk');
    });

    it('should throw when key thumbprint does not match cnf.jkt', async () => {
      mockJose.decodeJwt.mockReturnValue({ sub: mockDid, exp: 9999999999, cnf: { jkt: 'expected-jkt' } });
      mockJose.decodeProtectedHeader.mockReturnValue({ alg: 'ES256', jwk: mockJwk } as unknown as jose.ProtectedHeaderParameters);
      (mockJose.calculateJwkThumbprint as jest.Mock).mockResolvedValue('wrong-thumbprint');
      await expect(verifyDpopBoundToken(accessToken, dpopProof)).rejects.toThrow('DPoP key thumbprint does not match');
    });

    it('should throw when DPoP proof signature is invalid', async () => {
      mockJose.decodeJwt.mockReturnValue({ sub: mockDid, exp: 9999999999, cnf: { jkt: 'valid-thumbprint' } });
      mockJose.decodeProtectedHeader.mockReturnValue({ alg: 'ES256', jwk: mockJwk } as unknown as jose.ProtectedHeaderParameters);
      (mockJose.calculateJwkThumbprint as jest.Mock).mockResolvedValue('valid-thumbprint');
      (mockJose.importJWK as jest.Mock).mockResolvedValue({});
      mockJose.jwtVerify.mockRejectedValue(new Error('signature invalid'));
      await expect(verifyDpopBoundToken(accessToken, dpopProof)).rejects.toThrow('DPoP proof verification failed: signature invalid');
    });

    it('should handle non-Error rejection from DPoP proof jwtVerify', async () => {
      mockJose.decodeJwt.mockReturnValue({ sub: mockDid, exp: 9999999999, cnf: { jkt: 'valid-thumbprint' } });
      mockJose.decodeProtectedHeader.mockReturnValue({ alg: 'ES256', jwk: mockJwk } as unknown as jose.ProtectedHeaderParameters);
      (mockJose.calculateJwkThumbprint as jest.Mock).mockResolvedValue('valid-thumbprint');
      (mockJose.importJWK as jest.Mock).mockResolvedValue({});
      mockJose.jwtVerify.mockRejectedValue('non-error string');
      await expect(verifyDpopBoundToken(accessToken, dpopProof)).rejects.toThrow('DPoP proof verification failed: non-error string');
    });

    it('should throw when DPoP proof is too old', async () => {
      mockJose.decodeJwt.mockReturnValue({ sub: mockDid, exp: 9999999999, cnf: { jkt: 'valid-thumbprint' } });
      mockJose.decodeProtectedHeader.mockReturnValue({ alg: 'ES256', jwk: mockJwk } as unknown as jose.ProtectedHeaderParameters);
      (mockJose.calculateJwkThumbprint as jest.Mock).mockResolvedValue('valid-thumbprint');
      (mockJose.importJWK as jest.Mock).mockResolvedValue({});
      mockJose.jwtVerify.mockResolvedValue({
        payload: { iat: Math.floor(Date.now() / 1000) - 120, ath: validAth },
        protectedHeader: { alg: 'ES256' },
      } as unknown as jose.JWTVerifyResult);
      await expect(verifyDpopBoundToken(accessToken, dpopProof)).rejects.toThrow('DPoP proof too old');
    });

    it('should throw when ath does not match access token', async () => {
      mockJose.decodeJwt.mockReturnValue({ sub: mockDid, exp: 9999999999, cnf: { jkt: 'valid-thumbprint' } });
      mockJose.decodeProtectedHeader.mockReturnValue({ alg: 'ES256', jwk: mockJwk } as unknown as jose.ProtectedHeaderParameters);
      (mockJose.calculateJwkThumbprint as jest.Mock).mockResolvedValue('valid-thumbprint');
      (mockJose.importJWK as jest.Mock).mockResolvedValue({});
      mockJose.jwtVerify.mockResolvedValue({
        payload: { iat: Math.floor(Date.now() / 1000), ath: 'wrong-ath' },
        protectedHeader: { alg: 'ES256' },
      } as unknown as jose.JWTVerifyResult);
      await expect(verifyDpopBoundToken(accessToken, dpopProof)).rejects.toThrow('DPoP ath claim does not match');
    });

    it('should throw when access token payload cannot be decoded', async () => {
      mockJose.decodeJwt.mockImplementation(() => { throw new Error('invalid'); });
      await expect(verifyDpopBoundToken(accessToken, dpopProof)).rejects.toThrow('Invalid access token: cannot decode payload');
    });
  });
});
