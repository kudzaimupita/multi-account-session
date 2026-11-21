/** Milliseconds since the Unix epoch. Injected so tests can control time. */
export type Clock = () => number;

/** Small, display-only data kept next to an account (name, email, avatar URL). */
export type AccountProfile = Readonly<Record<string, string>>;

export interface AccountEntry {
  /** The application's own identifier for the account. */
  readonly accountId: string;
  readonly profile: AccountProfile;
  /** When this account was signed in to this session. Drives absolute expiry. */
  readonly signedInAt: number;
  /** Last time a request was resolved to this account. Drives idle expiry. */
  readonly lastActiveAt: number;
}

export interface SessionRecord {
  /** Opaque random identifier. Replaced on every sign-in and sign-out. */
  readonly id: string;
  /** Signed-in accounts in sign-in order. The position is the account index. */
  readonly accounts: readonly AccountEntry[];
  /** Account used when a request names no explicit index. Always in `accounts`. */
  readonly defaultAccountId: string;
  readonly createdAt: number;
  /** When the last account in the session expires. Stores may sweep after this. */
  readonly expiresAt: number;
}

/**
 * Persistence for session records.
 *
 * Implementations must return values that do not alias their internal state,
 * and `update` must be atomic with respect to `delete`: once a session is
 * deleted, a concurrent `update` must not bring it back.
 */
export interface SessionStore {
  get(id: string): Promise<SessionRecord | undefined>;
  /** Insert or replace the record stored under `record.id`. */
  set(record: SessionRecord): Promise<void>;
  /** Remove a record. Removing an unknown id is not an error. */
  delete(id: string): Promise<void>;
  /**
   * Read, change and write back one record in a single step. `change` may
   * return a new record (which must keep the same id) or `undefined` to delete
   * it. If the id is unknown, `change` is not called and nothing is created.
   * Resolves to the stored result.
   */
  update(
    id: string,
    change: (current: SessionRecord) => SessionRecord | undefined,
  ): Promise<SessionRecord | undefined>;
  /** Remove every record with `expiresAt <= now`. Resolves to how many went. */
  deleteExpired(now: number): Promise<number>;
}

export interface SignInInput {
  readonly accountId: string;
  readonly profile?: AccountProfile;
}

export type Resolution =
  | {
      readonly kind: 'active';
      readonly account: AccountEntry;
      readonly index: number;
      /** True when the request named the index, false when the default was used. */
      readonly explicit: boolean;
    }
  | {
      readonly kind: 'none';
      readonly reason: 'no_session' | 'no_such_index';
    };
