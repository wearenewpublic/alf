// Tests for AES-256-GCM encrypt/decrypt utilities

import { encrypt, decrypt, validateEncryptionKey } from '../encrypt';

const KEY = 'a'.repeat(64); // valid 32-byte hex key

describe('encrypt / decrypt', () => {
  it('roundtrips a plain string', () => {
    const plaintext = 'hello, world!';
    const ciphertext = encrypt(plaintext, KEY);
    expect(decrypt(ciphertext, KEY)).toBe(plaintext);
  });

  it('roundtrips an empty string', () => {
    const ciphertext = encrypt('', KEY);
    expect(decrypt(ciphertext, KEY)).toBe('');
  });

  it('roundtrips a unicode string', () => {
    const plaintext = '日本語テスト 🚀';
    expect(decrypt(encrypt(plaintext, KEY), KEY)).toBe(plaintext);
  });

  it('produces different ciphertexts for the same input (random IV)', () => {
    const c1 = encrypt('same', KEY);
    const c2 = encrypt('same', KEY);
    expect(c1).not.toBe(c2);
  });

  it('encrypted output has three colon-separated parts', () => {
    const parts = encrypt('test', KEY).split(':');
    expect(parts).toHaveLength(3);
  });

  it('throws on malformed encrypted string (missing parts)', () => {
    expect(() => decrypt('onlyone', KEY)).toThrow('Invalid encrypted string format');
  });

  it('throws on malformed encrypted string (too few colons)', () => {
    expect(() => decrypt('a:b', KEY)).toThrow('Invalid encrypted string format');
  });
});

describe('validateEncryptionKey', () => {
  it('accepts a valid 64-char lowercase hex string', () => {
    expect(validateEncryptionKey('a'.repeat(64))).toBe(true);
  });

  it('accepts a valid 64-char uppercase hex string', () => {
    expect(validateEncryptionKey('A'.repeat(64))).toBe(true);
  });

  it('accepts a mixed-case hex string', () => {
    expect(validateEncryptionKey('aAbBcCdDeEfF'.repeat(5) + 'aAbB')).toBe(true);
  });

  it('rejects a string that is too short', () => {
    expect(validateEncryptionKey('abc')).toBe(false);
  });

  it('rejects a string that is too long', () => {
    expect(validateEncryptionKey('a'.repeat(65))).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(validateEncryptionKey('z'.repeat(64))).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(validateEncryptionKey('')).toBe(false);
  });
});
