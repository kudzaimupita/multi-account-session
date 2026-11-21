import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { FileSessionStore, generateKey, keyFromString } from '../../src/index.ts';
import { createApp } from './app.ts';

const dataDirectory = join(import.meta.dirname, '.data');
const port = Number(process.env.PORT ?? 3000);
const secureCookies = process.env.SECURE_COOKIES === '1';

/**
 * Demo only: keep a generated key next to the session file so that sessions
 * survive a restart. A real deployment gets its key from a secret manager.
 */
async function loadOrCreateKey(): Promise<Buffer> {
  const path = join(dataDirectory, 'demo-cookie-key');
  await mkdir(dataDirectory, { recursive: true });
  try {
    return keyFromString(await readFile(path, 'utf8'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const key = generateKey();
  await writeFile(path, key.toString('base64url'), { mode: 0o600, flag: 'wx' });
  return key;
}

const store = await FileSessionStore.open(join(dataDirectory, 'sessions.json'));
const { app, manager } = createApp({
  store,
  keys: { current: await loadOrCreateKey() },
  secureCookies,
});

const sweeper = setInterval(
  () => {
    manager.sweep().catch((error: unknown) => {
      console.error('sweep failed', error);
    });
  },
  10 * 60 * 1000,
);
sweeper.unref();

const server = app.listen(port, '127.0.0.1', () => {
  console.log(`demo listening on http://localhost:${port}`);
  if (!secureCookies) {
    console.log('plain HTTP: using cookies without Secure or the __Host- prefix (demo only)');
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    clearInterval(sweeper);
    server.close(() => {
      void store.flush().finally(() => process.exit(0));
    });
  });
}
