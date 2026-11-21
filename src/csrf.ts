import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

import type { KeyRing } from './cookie/seal.ts';

const NONCE_BYTES = 16;
const MAC_BYTES = 32;
const MAX_TOKEN_LENGTH = 128;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const HKDF_INFO = 'multi-account-session/csrf/v1';

/**
 * The CSRF key is derived from the cookie key with HKDF-SHA-256 under its own
 * label, so the same bytes are never used for both AES-GCM and HMAC.
 */
function deriveKey(key: Uint8Array): Buffer {
  return Buffer.from(hkdfSync('sha256', key, new Uint8Array(0), HKDF_INFO, MAC_BYTES));
}

function mac(key: Uint8Array, sessionId: string | undefined, nonce: string): Buffer {
  // Session ids and nonces are base64url, so a newline cannot occur in either
  // and the three fields cannot run into each other.
  return createHmac('sha256', deriveKey(key))
    .update(`v1\n${sessionId ?? ''}\n${nonce}`)
    .digest();
}

/**
 * Compare two strings without the time taken depending on where they differ.
 * Both sides are hashed first so that inputs of different lengths can be
 * compared by `timingSafeEqual`, which requires equal lengths.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

/**
 * Make a token of the form `<nonce>.<mac>` where the MAC covers the nonce and
 * the session id. Pass `undefined` for a visitor with no session yet (the
 * sign-in form): the token is then only valid while there is still no session.
 */
export function createCsrfToken(keys: KeyRing, sessionId: string | undefined): string {
  const nonce = randomBytes(NONCE_BYTES).toString('base64url');
  return `${nonce}.${mac(keys.current, sessionId, nonce).toString('base64url')}`;
}

/** True if `token` was made by `createCsrfToken` for this session with one of the keys. */
export function verifyCsrfToken(
  keys: KeyRing,
  sessionId: string | undefined,
  token: string | undefined,
): boolean {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) {
    return false;
  }
  const [nonce, macText] = token.split('.') as [string, string];
  const given = Buffer.from(macText, 'base64url');
  if (given.byteLength !== MAC_BYTES) return false;
  let valid = false;
  // Every key is tried even after a match, so timing does not show which matched.
  for (const key of [keys.current, ...(keys.previous ?? [])]) {
    if (timingSafeEqual(given, mac(key, sessionId, nonce))) valid = true;
  }
  return valid;
}

/**
 * The full check for a state-changing request.
 *
 * 1. Double submit: the token sent with the request (form field or header)
 *    must equal the token in the CSRF cookie. Another site can make the
 *    browser send the cookie but cannot read it or set a matching field.
 * 2. Signed and bound: the token must carry a valid MAC over the current
 *    session id, so a token planted by an attacker who can write cookies, or
 *    one issued for a different or earlier session, is refused.
 */
export function verifyCsrfRequest(
  keys: KeyRing,
  sessionId: string | undefined,
  cookieToken: string | undefined,
  submittedToken: string | undefined,
): boolean {
  if (typeof cookieToken !== 'string' || typeof submittedToken !== 'string') return false;
  const same = constantTimeEqual(cookieToken, submittedToken);
  const signed = verifyCsrfToken(keys, sessionId, submittedToken);
  return same && signed;
}
