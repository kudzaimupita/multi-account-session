import { describe, expect, it } from 'vitest';

import {
  assertCookieConfig,
  readCookie,
  serializeClearCookie,
  serializeCookie,
} from '../src/index.ts';

describe('serializeCookie', () => {
  it('defaults to Secure, HttpOnly, SameSite=Lax and Path=/', () => {
    expect(serializeCookie('__Host-mas', 'abc')).toBe(
      '__Host-mas=abc; Path=/; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it('adds Max-Age in whole seconds', () => {
    expect(serializeCookie('sid', 'abc', { maxAgeSeconds: 90.9 })).toContain('; Max-Age=90;');
  });

  it('clears a cookie with Max-Age=0 and the same attributes', () => {
    expect(serializeClearCookie('__Host-mas')).toBe(
      '__Host-mas=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it('refuses values that could inject attributes', () => {
    expect(() => serializeCookie('sid', 'abc; Domain=evil.test')).toThrow(/illegal/);
    expect(() => serializeCookie('sid', 'abc', { path: '/; Domain=evil.test' })).toThrow(/illegal/);
    expect(() => serializeCookie('bad name', 'abc')).toThrow(/invalid cookie name/);
  });
});

describe('assertCookieConfig', () => {
  it('holds __Host- cookies to the rules browsers enforce', () => {
    expect(() => {
      assertCookieConfig('__Host-mas', { secure: false });
    }).toThrow(/__Host-/);
    expect(() => {
      assertCookieConfig('__Host-mas', { domain: 'example.test' });
    }).toThrow(/__Host-/);
    expect(() => {
      assertCookieConfig('__Host-mas', { path: '/app' });
    }).toThrow(/__Host-/);
    expect(() => {
      assertCookieConfig('__Host-mas');
    }).not.toThrow();
  });

  it('requires Secure for __Secure- cookies and SameSite=None', () => {
    expect(() => {
      assertCookieConfig('__Secure-mas', { secure: false });
    }).toThrow(/__Secure-/);
    expect(() => {
      assertCookieConfig('mas', { secure: false, sameSite: 'None' });
    }).toThrow(/SameSite=None/);
  });

  it('allows an unprefixed, non-Secure cookie for local development', () => {
    expect(() => {
      assertCookieConfig('mas', { secure: false });
    }).not.toThrow();
  });
});

describe('readCookie', () => {
  it('finds a cookie among several', () => {
    expect(readCookie('a=1; __Host-mas=v1.x.y.z; b=2', '__Host-mas')).toBe('v1.x.y.z');
  });

  it('matches the whole name only', () => {
    expect(readCookie('__Host-mas-csrf=token', '__Host-mas')).toBeUndefined();
    expect(readCookie('x__Host-mas=1', '__Host-mas')).toBeUndefined();
  });

  it('keeps = signs inside the value and strips quotes', () => {
    expect(readCookie('a=b=c', 'a')).toBe('b=c');
    expect(readCookie('a="quoted"', 'a')).toBe('quoted');
  });

  it('uses the first of duplicate names', () => {
    expect(readCookie('a=first; a=second', 'a')).toBe('first');
  });

  it('returns undefined when the header or cookie is missing', () => {
    expect(readCookie(undefined, 'a')).toBeUndefined();
    expect(readCookie('', 'a')).toBeUndefined();
    expect(readCookie('b=1; junk', 'a')).toBeUndefined();
  });
});
