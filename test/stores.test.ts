import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileSessionStore, MemorySessionStore, type SessionRecord } from '../src/index.ts';
import { describeStoreConformance } from '../src/testing/store-conformance.ts';

describeStoreConformance('MemorySessionStore', async () => ({ store: new MemorySessionStore() }));

describeStoreConformance('FileSessionStore', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mas-conformance-'));
  const path = join(directory, 'sessions.json');
  return {
    store: await FileSessionStore.open(path),
    reopen: () => FileSessionStore.open(path),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
});

const sample: SessionRecord = {
  id: 's1',
  accounts: [{ accountId: 'a1', index: 0, profile: {}, signedInAt: 1, lastActiveAt: 1 }],
  nextIndex: 1,
  defaultAccountId: 'a1',
  createdAt: 1,
  expiresAt: 100,
};

describe('FileSessionStore', () => {
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mas-file-'));
    path = join(directory, 'nested', 'sessions.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('creates missing directories and starts empty', async () => {
    const store = await FileSessionStore.open(path);
    expect(await store.get('s1')).toBeUndefined();
  });

  it('leaves no temporary files behind after many overlapping writes', async () => {
    const store = await FileSessionStore.open(path);
    await Promise.all(
      Array.from({ length: 25 }, (_, n) => store.set({ ...sample, id: `s${String(n)}` })),
    );
    expect(await readdir(join(directory, 'nested'))).toEqual(['sessions.json']);
    const reopened = await FileSessionStore.open(path);
    for (let n = 0; n < 25; n += 1) {
      expect(await reopened.get(`s${String(n)}`)).toBeDefined();
    }
  });

  it('always has a complete, parseable file on disk while writes are in flight', async () => {
    const store = await FileSessionStore.open(path);
    await store.set(sample);
    const writes = Array.from({ length: 30 }, (_, n) =>
      store.set({ ...sample, id: `w${String(n)}` }),
    );
    const reads: number[] = [];
    for (let n = 0; n < 30; n += 1) {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as { sessions: unknown[] };
      reads.push(parsed.sessions.length);
    }
    await Promise.all(writes);
    expect(reads.every((count) => count >= 1)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'writes the file readable by the owner only',
    async () => {
      const store = await FileSessionStore.open(path);
      await store.set(sample);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    },
  );

  it('refuses to open a file that is not JSON rather than starting empty', async () => {
    const store = await FileSessionStore.open(path);
    await store.set(sample);
    await writeFile(path, '{"version":1,"sessions":[{"id":"s1"');
    await expect(FileSessionStore.open(path)).rejects.toMatchObject({ code: 'store_corrupt' });
  });

  it('refuses an unknown format version and malformed records', async () => {
    await FileSessionStore.open(path);
    await writeFile(path, JSON.stringify({ version: 2, sessions: [] }));
    await expect(FileSessionStore.open(path)).rejects.toMatchObject({ code: 'store_corrupt' });
    await writeFile(path, JSON.stringify({ version: 1, sessions: [{ id: 's1' }] }));
    await expect(FileSessionStore.open(path)).rejects.toMatchObject({ code: 'store_corrupt' });
  });

  it('reports a failed write to the caller', async () => {
    const store = await FileSessionStore.open(path);
    await rm(join(directory, 'nested'), { recursive: true });
    await expect(store.set(sample)).rejects.toThrow();
  });
});
