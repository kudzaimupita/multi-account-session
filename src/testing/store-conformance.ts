import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionRecord, SessionStore } from '../types.ts';

export interface StoreHarness {
  readonly store: SessionStore;
  /**
   * For stores that persist: open a second instance over the same data, as a
   * restarted process would. Leave out for stores that keep nothing.
   */
  readonly reopen?: () => Promise<SessionStore>;
  readonly cleanup?: () => Promise<void>;
}

function record(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    accounts: [
      { accountId: 'a1', profile: { name: 'One' }, signedInAt: 1_000, lastActiveAt: 1_000 },
      { accountId: 'a2', profile: {}, signedInAt: 2_000, lastActiveAt: 2_500 },
    ],
    defaultAccountId: 'a1',
    createdAt: 1_000,
    expiresAt: 10_000,
    ...overrides,
  };
}

/**
 * The behaviour every `SessionStore` must have. Call it from a vitest file
 * with a factory that makes a fresh, empty store for each test:
 *
 *     describeStoreConformance('MyStore', async () => ({ store: new MyStore() }));
 */
export function describeStoreConformance(
  name: string,
  createHarness: () => Promise<StoreHarness>,
): void {
  describe(`${name}: SessionStore conformance`, () => {
    let harness: StoreHarness;
    let store: SessionStore;

    beforeEach(async () => {
      harness = await createHarness();
      store = harness.store;
    });

    afterEach(async () => {
      await harness.cleanup?.();
    });

    it('returns undefined for an unknown id', async () => {
      expect(await store.get('missing')).toBeUndefined();
    });

    it('returns what was set', async () => {
      await store.set(record('s1'));
      expect(await store.get('s1')).toEqual(record('s1'));
    });

    it('replaces a record set under the same id', async () => {
      await store.set(record('s1'));
      await store.set(record('s1', { defaultAccountId: 'a2' }));
      expect((await store.get('s1'))?.defaultAccountId).toBe('a2');
    });

    it('keeps records under different ids apart', async () => {
      await store.set(record('s1'));
      await store.set(record('s2', { defaultAccountId: 'a2' }));
      expect((await store.get('s1'))?.defaultAccountId).toBe('a1');
      expect((await store.get('s2'))?.defaultAccountId).toBe('a2');
    });

    it('preserves account order', async () => {
      await store.set(record('s1'));
      expect((await store.get('s1'))?.accounts.map((a) => a.accountId)).toEqual(['a1', 'a2']);
    });

    it('does not alias the record passed to set', async () => {
      const input = structuredClone(record('s1')) as { defaultAccountId: string } & SessionRecord;
      await store.set(input);
      input.defaultAccountId = 'changed';
      expect((await store.get('s1'))?.defaultAccountId).toBe('a1');
    });

    it('does not alias the record returned by get', async () => {
      await store.set(record('s1'));
      const first = (await store.get('s1')) as { defaultAccountId: string } & SessionRecord;
      first.defaultAccountId = 'changed';
      expect((await store.get('s1'))?.defaultAccountId).toBe('a1');
    });

    it('deletes a record', async () => {
      await store.set(record('s1'));
      await store.delete('s1');
      expect(await store.get('s1')).toBeUndefined();
    });

    it('treats deleting an unknown id as a no-op', async () => {
      await expect(store.delete('missing')).resolves.toBeUndefined();
    });

    it('updates a record and returns the stored result', async () => {
      await store.set(record('s1'));
      const result = await store.update('s1', (current) => ({
        ...current,
        defaultAccountId: 'a2',
      }));
      expect(result?.defaultAccountId).toBe('a2');
      expect((await store.get('s1'))?.defaultAccountId).toBe('a2');
    });

    it('does not call change or create anything when updating an unknown id', async () => {
      let called = false;
      const result = await store.update('missing', (current) => {
        called = true;
        return current;
      });
      expect(result).toBeUndefined();
      expect(called).toBe(false);
      expect(await store.get('missing')).toBeUndefined();
    });

    it('deletes the record when change returns undefined', async () => {
      await store.set(record('s1'));
      expect(await store.update('s1', () => undefined)).toBeUndefined();
      expect(await store.get('s1')).toBeUndefined();
    });

    it('refuses an update that changes the id', async () => {
      await store.set(record('s1'));
      await expect(store.update('s1', (current) => ({ ...current, id: 's2' }))).rejects.toThrow();
      expect(await store.get('s2')).toBeUndefined();
    });

    it('does not bring back a record deleted while an update was pending', async () => {
      await store.set(record('s1'));
      const deleting = store.delete('s1');
      const updating = store.update('s1', (current) => ({ ...current, expiresAt: 99_999 }));
      await Promise.all([deleting, updating]);
      expect(await store.get('s1')).toBeUndefined();
    });

    it('applies concurrent updates one at a time', async () => {
      await store.set(record('s1', { expiresAt: 0 }));
      await Promise.all(
        Array.from({ length: 20 }, () =>
          store.update('s1', (current) => ({ ...current, expiresAt: current.expiresAt + 1 })),
        ),
      );
      expect((await store.get('s1'))?.expiresAt).toBe(20);
    });

    it('deleteExpired removes records at or past expiresAt and keeps the rest', async () => {
      await store.set(record('old', { expiresAt: 100 }));
      await store.set(record('edge', { expiresAt: 200 }));
      await store.set(record('live', { expiresAt: 201 }));
      expect(await store.deleteExpired(200)).toBe(2);
      expect(await store.get('old')).toBeUndefined();
      expect(await store.get('edge')).toBeUndefined();
      expect(await store.get('live')).toBeDefined();
      expect(await store.deleteExpired(200)).toBe(0);
    });

    it('accepts ids with characters used by base64url', async () => {
      const id = 'Ab-_09zZ';
      await store.set(record(id));
      expect((await store.get(id))?.id).toBe(id);
    });

    it('keeps data across a reopen, if the store persists', async (context) => {
      if (!harness.reopen) {
        context.skip();
        return;
      }
      await store.set(record('kept'));
      await store.set(record('dropped'));
      await store.delete('dropped');
      await store.update('kept', (current) => ({ ...current, defaultAccountId: 'a2' }));
      const reopened = await harness.reopen();
      expect(await reopened.get('kept')).toEqual(record('kept', { defaultAccountId: 'a2' }));
      expect(await reopened.get('dropped')).toBeUndefined();
    });
  });
}
