import { MultiAccountError } from '../errors.ts';

export interface CookieOptions {
  /** Default `/`. */
  readonly path?: string;
  /** Default: not set, so the cookie is bound to the exact host. */
  readonly domain?: string;
  /** Default true. */
  readonly secure?: boolean;
  /** Default true. */
  readonly httpOnly?: boolean;
  /** Default `Lax`. */
  readonly sameSite?: 'Lax' | 'Strict' | 'None';
  /** Lifetime in seconds. Omit for a cookie that ends with the browser session. */
  readonly maxAgeSeconds?: number;
}

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VALUE = /^[!#$%&'()*+\-./0-9:<=>?@A-Z[\]^_`a-z{|}~]*$/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const ATTRIBUTE_VALUE = /^[^;\u0000-\u001f\u007f]*$/;

/**
 * Check a cookie name against its options. The `__Host-` and `__Secure-`
 * prefixes are promises the browser enforces, so a mismatch would make it
 * drop the cookie without telling anyone. Failing here is easier to debug.
 */
export function assertCookieConfig(name: string, options: CookieOptions = {}): void {
  if (!COOKIE_NAME.test(name)) {
    throw new MultiAccountError('invalid_cookie_options', `invalid cookie name: ${name}`);
  }
  const secure = options.secure ?? true;
  if (name.startsWith('__Host-')) {
    if (!secure || (options.path ?? '/') !== '/' || options.domain !== undefined) {
      throw new MultiAccountError(
        'invalid_cookie_options',
        'a __Host- cookie must be Secure, have Path=/ and no Domain',
      );
    }
  }
  if (name.startsWith('__Secure-') && !secure) {
    throw new MultiAccountError('invalid_cookie_options', 'a __Secure- cookie must be Secure');
  }
  if (options.sameSite === 'None' && !secure) {
    throw new MultiAccountError('invalid_cookie_options', 'SameSite=None requires Secure');
  }
}

/** Build a `Set-Cookie` header value. */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  assertCookieConfig(name, options);
  if (!COOKIE_VALUE.test(value)) {
    throw new MultiAccountError('invalid_cookie_options', 'cookie value has illegal characters');
  }
  const path = options.path ?? '/';
  if (!ATTRIBUTE_VALUE.test(path) || (options.domain && !ATTRIBUTE_VALUE.test(options.domain))) {
    throw new MultiAccountError(
      'invalid_cookie_options',
      'cookie attribute has illegal characters',
    );
  }
  const parts = [`${name}=${value}`, `Path=${path}`];
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  }
  if (options.httpOnly ?? true) parts.push('HttpOnly');
  if (options.secure ?? true) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}

/** Build a `Set-Cookie` header value that removes the cookie. */
export function serializeClearCookie(name: string, options: CookieOptions = {}): string {
  return serializeCookie(name, '', { ...options, maxAgeSeconds: 0 });
}

/**
 * Read one cookie from a `Cookie` request header. If the name appears more
 * than once the first is used, which is the one browsers list first.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== name) continue;
    const value = pair.slice(separator + 1).trim();
    return value.startsWith('"') && value.endsWith('"') && value.length >= 2
      ? value.slice(1, -1)
      : value;
  }
  return undefined;
}
