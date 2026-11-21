import type { SessionRecord, SessionStore } from '../types.ts';

/**
 * Keeps sessions in a Map. Everything is lost when the process exits, and
 * nothing is shared between processes: use it for tests and single-process
 * development.
 */
export class MemorySessionStore implements SessionStore {
  readonly #records = new Map<string, SessionRecord>();

  constructor(initial: Iterable<SessionRecord> = []) {
    for (const record of initial) this.#records.set(record.id, structuredClone(record));
  }

  get size(): number {
    return this.#records.size;
  }

  /** A copy of every record, in insertion order. */
  snapshot(): SessionRecord[] {
    return [...this.#records.values()].map((record) => structuredClone(record));
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    const record = this.#records.get(id);
    return record && structuredClone(record);
  }

  async set(record: SessionRecord): Promise<void> {
    this.#records.set(record.id, structuredClone(record));
  }

  async delete(id: string): Promise<void> {
    this.#records.delete(id);
  }

  // The read, the change and the write happen without yielding to the event
  // loop, so nothing can interleave with them inside one process.
  async update(
    id: string,
    change: (current: SessionRecord) => SessionRecord | undefined,
  ): Promise<SessionRecord | undefined> {
    const current = this.#records.get(id);
    if (!current) return undefined;
    const next = change(structuredClone(current));
    if (!next) {
      this.#records.delete(id);
      return undefined;
    }
    if (next.id !== id) throw new Error('update must not change the session id');
    this.#records.set(id, structuredClone(next));
    return structuredClone(next);
  }

  async deleteExpired(now: number): Promise<number> {
    let removed = 0;
    for (const [id, record] of this.#records) {
      if (record.expiresAt <= now) {
        this.#records.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}
