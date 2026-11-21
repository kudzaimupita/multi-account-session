import { randomBytes } from 'node:crypto';

import { MultiAccountError } from '../errors.ts';
import { MAX_ACCOUNT_INDEX } from './resolve.ts';
import type { AccountEntry, Clock, SessionRecord, SessionStore, SignInInput } from '../types.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MAX_ACCOUNT_ID_LENGTH = 256;

export interface SessionManagerOptions {
  readonly store: SessionStore;
  readonly clock?: Clock;
  /** An account not used for this long is signed out. Default 7 days. */
  readonly idleTimeoutMs?: number;
  /** An account is signed out this long after sign-in, used or not. Default 30 days. */
  readonly absoluteTimeoutMs?: number;
  /** Upper bound on accounts in one session. Default 10. */
  readonly maxAccounts?: number;
  /**
   * Activity is written to the store at most this often per account, so a busy
   * session does not cause a write on every request. Default 1 minute.
   */
  readonly touchIntervalMs?: number;
  /** Override id generation. Only meant for tests. */
  readonly generateId?: () => string;
}

export interface SignInResult {
  readonly session: SessionRecord;
  /** Index of the account that was just signed in. */
  readonly index: number;
}

/** 256 bits from the OS random source, base64url encoded. */
export function generateSessionId(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Operations on multi-account sessions. Knows nothing about HTTP: callers pass
 * in the session id they read from the request and are told the new one.
 *
 * Every sign-in and sign-out moves the session to a fresh id and deletes the
 * old one, so an id that was known before the change is worthless after it.
 */
export class SessionManager {
  readonly idleTimeoutMs: number;
  readonly absoluteTimeoutMs: number;
  readonly maxAccounts: number;
  readonly touchIntervalMs: number;
  readonly #store: SessionStore;
  readonly #clock: Clock;
  readonly #generateId: () => string;

  constructor(options: SessionManagerOptions) {
    this.#store = options.store;
    this.#clock = options.clock ?? Date.now;
    this.#generateId = options.generateId ?? generateSessionId;
    this.idleTimeoutMs = positive('idleTimeoutMs', options.idleTimeoutMs ?? 7 * DAY);
    this.absoluteTimeoutMs = positive('absoluteTimeoutMs', options.absoluteTimeoutMs ?? 30 * DAY);
    this.maxAccounts = positive('maxAccounts', options.maxAccounts ?? 10);
    this.touchIntervalMs = options.touchIntervalMs ?? MINUTE;
  }

  /**
   * Fetch a session and drop any account that has expired. A session whose
   * accounts have all expired is deleted and reported as absent.
   */
  async load(sessionId: string | undefined): Promise<SessionRecord | undefined> {
    if (!sessionId) return undefined;
    const record = await this.#store.get(sessionId);
    if (!record) return undefined;
    const now = this.#clock();
    if (record.accounts.every((a) => !this.#isExpired(a, now))) return record;
    return this.#store.update(sessionId, (current) => this.#prune(current, now));
  }

  /**
   * Sign an account in. Adds it to the session named by `sessionId`, or starts
   * a new session. Signing in an account that is already present refreshes it
   * in place and keeps its index. The session id always changes.
   */
  async addAccount(sessionId: string | undefined, input: SignInInput): Promise<SignInResult> {
    const accountId = input.accountId;
    if (
      typeof accountId !== 'string' ||
      accountId.length === 0 ||
      accountId.length > MAX_ACCOUNT_ID_LENGTH
    ) {
      throw new MultiAccountError('invalid_account', 'accountId must be a non-empty string');
    }

    const existing = await this.load(sessionId);
    const now = this.#clock();
    const accounts = existing ? [...existing.accounts] : [];
    let nextIndex = existing?.nextIndex ?? 0;

    const position = accounts.findIndex((a) => a.accountId === accountId);
    const known = accounts[position];
    if (!known) {
      if (accounts.length >= this.maxAccounts) {
        throw new MultiAccountError(
          'too_many_accounts',
          `a session holds at most ${this.maxAccounts} accounts`,
        );
      }
      if (nextIndex > MAX_ACCOUNT_INDEX) {
        throw new MultiAccountError(
          'too_many_accounts',
          'this session has used up its account indices; sign out of all accounts to start again',
        );
      }
    }
    const entry: AccountEntry = {
      accountId,
      index: known ? known.index : nextIndex++,
      profile: { ...input.profile },
      signedInAt: now,
      lastActiveAt: now,
    };
    if (known) accounts[position] = entry;
    else accounts.push(entry);

    const session = this.#finalise({
      id: this.#generateId(),
      accounts,
      nextIndex,
      defaultAccountId: existing?.defaultAccountId ?? accountId,
      createdAt: existing?.createdAt ?? now,
      expiresAt: 0,
    });
    await this.#rotate(existing, session);
    return { session, index: entry.index };
  }

  /**
   * Sign one account out. Resolves to the session that remains, under a new
   * id, or `undefined` if that was the last account. Removing an account that
   * is not signed in changes nothing.
   */
  async removeAccount(
    sessionId: string | undefined,
    accountId: string,
  ): Promise<SessionRecord | undefined> {
    const existing = await this.load(sessionId);
    if (!existing) return undefined;
    const accounts = existing.accounts.filter((a) => a.accountId !== accountId);
    if (accounts.length === existing.accounts.length) return existing;
    if (accounts.length === 0) {
      await this.#store.delete(existing.id);
      return undefined;
    }
    const session = this.#finalise({ ...existing, id: this.#generateId(), accounts });
    await this.#rotate(existing, session);
    return session;
  }

  /** Sign every account out and delete the session. */
  async removeAll(sessionId: string | undefined): Promise<void> {
    if (sessionId) await this.#store.delete(sessionId);
  }

  /**
   * Choose the account used when a request names no index. Not a sign-in or
   * sign-out, so the session id stays the same.
   */
  async setDefault(sessionId: string | undefined, accountId: string): Promise<SessionRecord> {
    const existing = await this.load(sessionId);
    if (!existing) throw new MultiAccountError('no_session', 'no active session');
    if (!existing.accounts.some((a) => a.accountId === accountId)) {
      throw new MultiAccountError('unknown_account', 'account is not signed in to this session');
    }
    const updated = await this.#store.update(existing.id, (current) =>
      current.accounts.some((a) => a.accountId === accountId)
        ? { ...current, defaultAccountId: accountId }
        : current,
    );
    if (!updated) throw new MultiAccountError('no_session', 'no active session');
    return updated;
  }

  /**
   * Record that an account was just used, which pushes back its idle expiry.
   * Skipped when the last recorded use is recent enough.
   */
  async touch(session: SessionRecord, accountId: string): Promise<SessionRecord | undefined> {
    const now = this.#clock();
    const account = session.accounts.find((a) => a.accountId === accountId);
    if (!account || now - account.lastActiveAt < this.touchIntervalMs) return session;
    return this.#store.update(session.id, (current) =>
      this.#finalise({
        ...current,
        accounts: current.accounts.map((a) =>
          a.accountId === accountId ? { ...a, lastActiveAt: Math.max(a.lastActiveAt, now) } : a,
        ),
      }),
    );
  }

  /** Remove sessions whose every account has expired. Run it on a timer. */
  async sweep(): Promise<number> {
    return this.#store.deleteExpired(this.#clock());
  }

  /** When the given account stops being valid if it is not used again. */
  accountExpiresAt(account: AccountEntry): number {
    return Math.min(
      account.signedInAt + this.absoluteTimeoutMs,
      account.lastActiveAt + this.idleTimeoutMs,
    );
  }

  #isExpired(account: AccountEntry, now: number): boolean {
    return now >= this.accountExpiresAt(account);
  }

  #prune(record: SessionRecord, now: number): SessionRecord | undefined {
    const accounts = record.accounts.filter((a) => !this.#isExpired(a, now));
    if (accounts.length === 0) return undefined;
    return this.#finalise({ ...record, accounts });
  }

  /** Restore the invariants: the default is a member, expiresAt is current. */
  #finalise(record: SessionRecord): SessionRecord {
    const first = record.accounts[0];
    if (!first) throw new MultiAccountError('no_session', 'a session needs at least one account');
    const hasDefault = record.accounts.some((a) => a.accountId === record.defaultAccountId);
    return {
      ...record,
      defaultAccountId: hasDefault ? record.defaultAccountId : first.accountId,
      expiresAt: Math.max(...record.accounts.map((a) => this.accountExpiresAt(a))),
    };
  }

  /**
   * Move a session to a new id. The old record is deleted first: if the
   * process dies between the two writes the user is signed out, which is the
   * safe way to fail. The other order would leave the old id usable.
   */
  async #rotate(previous: SessionRecord | undefined, next: SessionRecord): Promise<void> {
    if (previous) await this.#store.delete(previous.id);
    await this.#store.set(next);
  }
}

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number`);
  }
  return value;
}
