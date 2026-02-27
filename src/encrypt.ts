// ABOUTME: AES-256-GCM encryption utilities for storing sensitive tokens at rest

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

/**
 * Encrypt a string value using AES-256-GCM.
 * Returns a base64-encoded string: iv:authTag:ciphertext
 */
export function encrypt(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

/**
 * Decrypt a string encrypted by encrypt().
 */
export function decrypt(encryptedStr: string, keyHex: string): string {
  const parts = encryptedStr.split(':');
  const [ivB64, tagB64, ciphertextB64] = parts;
  if (ivB64 === undefined || tagB64 === undefined || ciphertextB64 === undefined || parts.length !== 3) {
    throw new Error('Invalid encrypted string format');
  }

  const key = Buffer.from(keyHex, 'hex');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return decipher.update(ciphertext).toString('utf8') + decipher.final('utf8');
}

// Validate that a key is a valid 64-char hex string (32 bytes)
export function validateEncryptionKey(keyHex: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(keyHex);
}
