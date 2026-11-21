import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { MultiAccountError } from '../errors.ts';

const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Sealed values longer than this are rejected before any cryptography runs. */
const MAX_SEALED_LENGTH = 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Keys for sealing. New values are always sealed with `current`. Values sealed
 * with any key in `previous` are still accepted, which is what lets a key be
 * replaced without signing everyone out: move the old key to `previous`, and
 * drop it once cookies sealed with it have expired.
 */
export interface KeyRing {
  readonly current: Uint8Array;
  readonly previous?: readonly Uint8Array[];
}

export interface Unsealed {
  readonly value: string;
  /** True when a previous key was needed. The caller should re-seal and re-issue. */
  readonly usedPreviousKey: boolean;
}

/** A fresh 256-bit key from the OS random source. */
export function generateKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** Decode a key stored as base64url, base64 or hex text. */
export function keyFromString(text: string): Buffer {
  const trimmed = text.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  assertKey(key);
  return key;
}

export function assertKeyRing(keys: KeyRing): void {
  assertKey(keys.current);
  for (const key of keys.previous ?? []) assertKey(key);
}

function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) {
    throw new MultiAccountError(
      'invalid_key',
      `keys must be exactly ${KEY_BYTES} random bytes; do not use a password or passphrase`,
    );
  }
}

/**
 * Encrypt and authenticate `value` with AES-256-GCM.
 *
 * Output is `v1.<iv>.<ciphertext>.<tag>`, each part base64url. A random 96-bit
 * IV is drawn per call. `context` is authenticated but not stored (GCM
 * associated data): a value sealed for one context will not open under
 * another, so a sealed session cookie cannot be replayed as some other cookie.
 */
export function seal(value: string, keys: KeyRing, context: string): string {
  assertKey(keys.current);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keys.current, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData(context));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, ciphertext, tag]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

/**
 * Open a sealed value. Returns `undefined` for anything that is not a value
 * sealed by one of the keys for this context: wrong key, wrong context,
 * modified, truncated or malformed. It never throws on bad input and gives no
 * hint as to which check failed.
 */
export function unseal(sealed: string, keys: KeyRing, context: string): Unsealed | undefined {
  if (sealed.length > MAX_SEALED_LENGTH) return undefined;
  const parts = sealed.split('.');
  if (parts.length !== 4) return undefined;
  const [version, ivText, ciphertextText, tagText] = parts as [string, string, string, string];
  if (version !== VERSION) return undefined;
  if (![ivText, ciphertextText, tagText].every((part) => BASE64URL.test(part))) return undefined;

  const iv = Buffer.from(ivText, 'base64url');
  const ciphertext = Buffer.from(ciphertextText, 'base64url');
  const tag = Buffer.from(tagText, 'base64url');
  if (iv.byteLength !== IV_BYTES || tag.byteLength !== TAG_BYTES) return undefined;

  const aad = associatedData(context);
  const candidates = [keys.current, ...(keys.previous ?? [])];
  for (const [position, key] of candidates.entries()) {
    const value = open(key, iv, ciphertext, tag, aad);
    if (value !== undefined) return { value, usedPreviousKey: position > 0 };
  }
  return undefined;
}

function open(
  key: Uint8Array,
  iv: Buffer,
  ciphertext: Buffer,
  tag: Buffer,
  aad: Buffer,
): string | undefined {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    // final() verifies the tag and throws if it does not match.
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

function associatedData(context: string): Buffer {
  return Buffer.from(`multi-account-session/${VERSION}/${context}`, 'utf8');
}
