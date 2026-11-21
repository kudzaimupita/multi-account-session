import { describe, expect, it } from 'vitest';

import { generateKey, keyFromString, seal, unseal } from '../src/index.ts';
import { testKey } from './helpers.ts';

const keys = { current: testKey(1) };
const CONTEXT = '__Host-mas';

/** Flip one bit in one base64url part of a sealed value. */
function flipBit(sealed: string, part: number): string {
  const parts = sealed.split('.');
  const bytes = Buffer.from(parts[part] ?? '', 'base64url');
  bytes[0] = (bytes[0] ?? 0) ^ 0x01;
  parts[part] = bytes.toString('base64url');
  return parts.join('.');
}

describe('seal / unseal', () => {
  it('round-trips a value', () => {
    const sealed = seal('session-id-123', keys, CONTEXT);
    expect(unseal(sealed, keys, CONTEXT)).toEqual({
      value: 'session-id-123',
      usedPreviousKey: false,
    });
  });

  it('does not expose the value in the sealed text', () => {
    const value = 'very-recognisable-session-id';
    const sealed = seal(value, keys, CONTEXT);
    expect(sealed).not.toContain(value);
    expect(sealed).not.toContain(Buffer.from(value).toString('base64url'));
  });

  it('uses a fresh IV each time, so equal values seal differently', () => {
    const a = seal('same', keys, CONTEXT);
    const b = seal('same', keys, CONTEXT);
    expect(a).not.toBe(b);
    expect(a.split('.')[1]).not.toBe(b.split('.')[1]);
  });

  it('produces only cookie-safe characters', () => {
    expect(seal('x'.repeat(43), keys, CONTEXT)).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it.each([
    ['IV', 1],
    ['ciphertext', 2],
    ['tag', 3],
  ])('rejects a value with a modified %s', (_name, part) => {
    const sealed = seal('session-id-123', keys, CONTEXT);
    expect(unseal(flipBit(sealed, part), keys, CONTEXT)).toBeUndefined();
  });

  it('rejects every single-character change to a sealed value', () => {
    const sealed = seal('session-id-123', keys, CONTEXT);
    for (let i = 0; i < sealed.length; i += 1) {
      const replacement = sealed[i] === 'A' ? 'B' : 'A';
      const changed = sealed.slice(0, i) + replacement + sealed.slice(i + 1);
      const opened = unseal(changed, keys, CONTEXT);
      // The last character of a base64url group can carry unused bits, so a
      // change there may decode to the same bytes. Anything that opens must
      // still be the original value.
      if (opened !== undefined) expect(opened.value).toBe('session-id-123');
    }
    const [version, iv, ciphertext, tag] = sealed.split('.') as [string, string, string, string];
    const firstCharFlipped = (text: string) => (text.startsWith('A') ? 'B' : 'A') + text.slice(1);
    for (const changed of [
      [version, firstCharFlipped(iv), ciphertext, tag],
      [version, iv, firstCharFlipped(ciphertext), tag],
      [version, iv, ciphertext, firstCharFlipped(tag)],
    ]) {
      expect(unseal(changed.join('.'), keys, CONTEXT)).toBeUndefined();
    }
  });

  it('rejects a value sealed with a different key', () => {
    const sealed = seal('session-id-123', { current: testKey(2) }, CONTEXT);
    expect(unseal(sealed, keys, CONTEXT)).toBeUndefined();
  });

  it('rejects a value sealed for a different context', () => {
    const sealed = seal('session-id-123', keys, 'other-cookie');
    expect(unseal(sealed, keys, CONTEXT)).toBeUndefined();
  });

  it('rejects truncated tags and wrong-size IVs', () => {
    const [version, iv, ciphertext, tag] = seal('abc', keys, CONTEXT).split('.') as [
      string,
      string,
      string,
      string,
    ];
    const shortTag = Buffer.from(tag, 'base64url').subarray(0, 12).toString('base64url');
    const shortIv = Buffer.from(iv, 'base64url').subarray(0, 8).toString('base64url');
    expect(unseal([version, iv, ciphertext, shortTag].join('.'), keys, CONTEXT)).toBeUndefined();
    expect(unseal([version, shortIv, ciphertext, tag].join('.'), keys, CONTEXT)).toBeUndefined();
  });

  it.each([
    '',
    'v1',
    'v1...',
    'not-a-sealed-value',
    'v2.AAAA.AAAA.AAAA',
    'v1.AAAA.AAAA.AAAA.AAAA',
    'v1.****.AAAA.AAAA',
    `v1.${'A'.repeat(2000)}.AAAA.AAAA`,
  ])('returns undefined for malformed input %j without throwing', (input) => {
    expect(unseal(input, keys, CONTEXT)).toBeUndefined();
  });

  it('refuses keys that are not 32 bytes', () => {
    expect(() => seal('x', { current: Buffer.alloc(16) }, CONTEXT)).toThrow(/32 random bytes/);
    expect(() => seal('x', { current: 'password' as unknown as Uint8Array }, CONTEXT)).toThrow(
      /32 random bytes/,
    );
  });
});

describe('key rotation', () => {
  const oldKey = testKey(1);
  const newKey = testKey(2);

  it('opens values sealed with a previous key and says so', () => {
    const sealed = seal('sid', { current: oldKey }, CONTEXT);
    expect(unseal(sealed, { current: newKey, previous: [oldKey] }, CONTEXT)).toEqual({
      value: 'sid',
      usedPreviousKey: true,
    });
  });

  it('seals new values with the current key only', () => {
    const sealed = seal('sid', { current: newKey, previous: [oldKey] }, CONTEXT);
    expect(unseal(sealed, { current: newKey }, CONTEXT)?.value).toBe('sid');
    expect(unseal(sealed, { current: oldKey }, CONTEXT)).toBeUndefined();
  });

  it('stops accepting a key once it is dropped from the ring', () => {
    const sealed = seal('sid', { current: oldKey }, CONTEXT);
    expect(unseal(sealed, { current: newKey }, CONTEXT)).toBeUndefined();
  });

  it('accepts any of several previous keys', () => {
    const oldest = testKey(9);
    const sealed = seal('sid', { current: oldest }, CONTEXT);
    const ring = { current: newKey, previous: [oldKey, oldest] };
    expect(unseal(sealed, ring, CONTEXT)?.usedPreviousKey).toBe(true);
  });
});

describe('key helpers', () => {
  it('generates distinct 32-byte keys', () => {
    const a = generateKey();
    expect(a.byteLength).toBe(32);
    expect(a.equals(generateKey())).toBe(false);
  });

  it('reads keys from base64url, base64 and hex', () => {
    const key = testKey(0xfb);
    expect(keyFromString(key.toString('base64url')).equals(key)).toBe(true);
    expect(keyFromString(key.toString('base64')).equals(key)).toBe(true);
    expect(keyFromString(`${key.toString('hex')}\n`).equals(key)).toBe(true);
  });

  it('refuses text that does not decode to 32 bytes', () => {
    expect(() => keyFromString('hunter2')).toThrow(/32 random bytes/);
  });
});
