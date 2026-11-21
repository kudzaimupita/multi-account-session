import { describe, expect, it } from 'vitest';

import {
  constantTimeEqual,
  createCsrfToken,
  verifyCsrfRequest,
  verifyCsrfToken,
} from '../src/index.ts';
import { testKey } from './helpers.ts';

const keys = { current: testKey(1) };

describe('CSRF tokens', () => {
  it('verifies a token for the session it was made for', () => {
    const token = createCsrfToken(keys, 'session-a');
    expect(verifyCsrfToken(keys, 'session-a', token)).toBe(true);
  });

  it('makes a different token each time', () => {
    expect(createCsrfToken(keys, 'session-a')).not.toBe(createCsrfToken(keys, 'session-a'));
  });

  it('rejects a token made for another session', () => {
    const token = createCsrfToken(keys, 'session-a');
    expect(verifyCsrfToken(keys, 'session-b', token)).toBe(false);
  });

  it('binds anonymous tokens to having no session', () => {
    const anonymous = createCsrfToken(keys, undefined);
    expect(verifyCsrfToken(keys, undefined, anonymous)).toBe(true);
    expect(verifyCsrfToken(keys, 'session-a', anonymous)).toBe(false);
    expect(verifyCsrfToken(keys, undefined, createCsrfToken(keys, 'session-a'))).toBe(false);
  });

  it('rejects a token signed with another key', () => {
    const token = createCsrfToken({ current: testKey(2) }, 'session-a');
    expect(verifyCsrfToken(keys, 'session-a', token)).toBe(false);
  });

  it('rejects a token whose nonce or MAC was changed', () => {
    const token = createCsrfToken(keys, 'session-a');
    const [nonce, mac] = token.split('.') as [string, string];
    const flip = (text: string) => (text.startsWith('A') ? 'B' : 'A') + text.slice(1);
    expect(verifyCsrfToken(keys, 'session-a', `${flip(nonce)}.${mac}`)).toBe(false);
    expect(verifyCsrfToken(keys, 'session-a', `${nonce}.${flip(mac)}`)).toBe(false);
  });

  it.each([undefined, '', '.', 'abc', 'a.b', 'a.b.c', 'x'.repeat(500), `${'A'.repeat(22)}.`])(
    'rejects malformed token %j without throwing',
    (token) => {
      expect(verifyCsrfToken(keys, 'session-a', token)).toBe(false);
    },
  );

  it('accepts tokens signed with a previous key during rotation', () => {
    const token = createCsrfToken({ current: testKey(1) }, 'session-a');
    const rotated = { current: testKey(2), previous: [testKey(1)] };
    expect(verifyCsrfToken(rotated, 'session-a', token)).toBe(true);
    expect(verifyCsrfToken({ current: testKey(2) }, 'session-a', token)).toBe(false);
  });
});

describe('verifyCsrfRequest (double submit)', () => {
  const token = createCsrfToken(keys, 'session-a');

  it('passes when cookie and submitted token match and are validly signed', () => {
    expect(verifyCsrfRequest(keys, 'session-a', token, token)).toBe(true);
  });

  it('fails when either side is missing', () => {
    expect(verifyCsrfRequest(keys, 'session-a', undefined, token)).toBe(false);
    expect(verifyCsrfRequest(keys, 'session-a', token, undefined)).toBe(false);
  });

  it('fails when the two differ, even if both are validly signed', () => {
    const other = createCsrfToken(keys, 'session-a');
    expect(verifyCsrfRequest(keys, 'session-a', token, other)).toBe(false);
  });

  it('fails for a matching pair that the server did not sign', () => {
    const forged = `${'A'.repeat(22)}.${'A'.repeat(43)}`;
    expect(verifyCsrfRequest(keys, 'session-a', forged, forged)).toBe(false);
  });

  it('fails for a matching pair issued for a different session', () => {
    expect(verifyCsrfRequest(keys, 'session-b', token, token)).toBe(false);
  });
});

describe('constantTimeEqual', () => {
  it('compares strings of any lengths', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});
