import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { MultiAccountError } from '../errors.ts';
import type { SessionRecord, SessionStore } from '../types.ts';
import { MemorySessionStore } from './memory.ts';

const FORMAT_VERSION = 1;

interface FileFormat {
  readonly version: number;
  readonly sessions: readonly SessionRecord[];
}

/**
 * Sessions in one JSON file, so they survive a restart.
 *
 * The file is read once when the store is opened. Every change rewrites the
 * whole file: the new content goes to a temporary file in the same directory,
 * is flushed to disk, and is then renamed over the old file. A reader, or a
 * crash at any point, sees either the old content or the new, never a mix.
 *
 * Meant for one process and a modest number of sessions. Two processes
 * pointed at the same file will overwrite each other's changes.
 */
export class FileSessionStore implements SessionStore {
  readonly path: string;
  readonly #records: MemorySessionStore;
  #queue: Promise<void> = Promise.resolve();

  private constructor(path: string, records: MemorySessionStore) {
    this.path = path;
    this.#records = records;
  }

  /** Open a store, creating the directory if needed. A missing file is an empty store. */
  static async open(path: string): Promise<FileSessionStore> {
    await mkdir(dirname(path), { recursive: true });
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return new FileSessionStore(path, new MemorySessionStore());
      }
      throw error;
    }
    return new FileSessionStore(path, new MemorySessionStore(parse(path, text)));
  }

  get(id: string): Promise<SessionRecord | undefined> {
    return this.#records.get(id);
  }

  async set(record: SessionRecord): Promise<void> {
    await this.#records.set(record);
    await this.#persist();
  }

  async delete(id: string): Promise<void> {
    await this.#records.delete(id);
    await this.#persist();
  }

  async update(
    id: string,
    change: (current: SessionRecord) => SessionRecord | undefined,
  ): Promise<SessionRecord | undefined> {
    const result = await this.#records.update(id, change);
    await this.#persist();
    return result;
  }

  async deleteExpired(now: number): Promise<number> {
    const removed = await this.#records.deleteExpired(now);
    if (removed > 0) await this.#persist();
    return removed;
  }

  /** Resolves once every write requested so far has reached the disk. */
  async flush(): Promise<void> {
    await this.#queue;
  }

  /**
   * Writes run one after another. Each one serialises the state as it is when
   * its turn comes, so a later write never puts older data on disk.
   */
  #persist(): Promise<void> {
    const run = this.#queue.then(() => this.#write());
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #write(): Promise<void> {
    const body: FileFormat = { version: FORMAT_VERSION, sessions: this.#records.snapshot() };
    const temporary = `${this.path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(body));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    await syncDirectory(dirname(this.path));
  }
}

/** Make the rename itself durable. Not possible on every platform, so best effort. */
async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directories cannot be opened or synced on some systems (Windows).
  }
}

function parse(path: string, text: string): SessionRecord[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new MultiAccountError('store_corrupt', `session file is not valid JSON: ${path}`);
  }
  if (!isObject(data) || data.version !== FORMAT_VERSION || !Array.isArray(data.sessions)) {
    throw new MultiAccountError('store_corrupt', `session file has an unknown format: ${path}`);
  }
  const sessions: unknown[] = data.sessions;
  if (!sessions.every(isSessionRecord)) {
    throw new MultiAccountError('store_corrupt', `session file has a malformed record: ${path}`);
  }
  return sessions;
}

function isSessionRecord(value: unknown): value is SessionRecord {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.defaultAccountId === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.nextIndex === 'number' &&
    typeof value.expiresAt === 'number' &&
    Array.isArray(value.accounts) &&
    value.accounts.every(
      (account: unknown) =>
        isObject(account) &&
        typeof account.accountId === 'string' &&
        typeof account.index === 'number' &&
        typeof account.signedInAt === 'number' &&
        typeof account.lastActiveAt === 'number' &&
        isObject(account.profile) &&
        Object.values(account.profile).every((field) => typeof field === 'string'),
    )
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
