import type { Resolution, SessionRecord } from '../types.ts';

/** Highest account index accepted from a request. */
export const MAX_ACCOUNT_INDEX = 999;

const INDEX_PATTERN = /^(?:0|[1-9]\d{0,2})$/;

/**
 * Parse an account index as it appears in a URL segment or header value.
 * Only canonical decimal integers are accepted: no sign, no leading zeros,
 * no whitespace.
 */
export function parseAccountIndex(value: string | undefined): number | undefined {
  if (value === undefined || !INDEX_PATTERN.test(value)) return undefined;
  return Number(value);
}

export interface PathIndex {
  readonly index: number;
  /** The path with the prefix removed. Always starts with `/`. */
  readonly rest: string;
}

/**
 * Split `/u/1/inbox?x=1` into index `1` and rest `/inbox?x=1`.
 * Returns `undefined` when the path does not start with `/<prefix>/<index>`.
 */
export function splitAccountPath(url: string, prefix = 'u'): PathIndex | undefined {
  const head = `/${prefix}/`;
  if (!url.startsWith(head)) return undefined;
  const afterHead = url.slice(head.length);
  const end = afterHead.search(/[/?#]/);
  const segment = end === -1 ? afterHead : afterHead.slice(0, end);
  const index = parseAccountIndex(segment);
  if (index === undefined) return undefined;
  const tail = end === -1 ? '' : afterHead.slice(end);
  return { index, rest: tail.startsWith('/') ? tail : `/${tail}` };
}

/** Build `/u/<index><path>` for links that should stay on one account. */
export function accountPath(index: number, path = '/', prefix = 'u'): string {
  if (!Number.isInteger(index) || index < 0 || index > MAX_ACCOUNT_INDEX) {
    throw new RangeError(`account index out of range: ${index}`);
  }
  return `/${prefix}/${index}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Decide which account a request acts as.
 *
 * With an explicit index the account at that position is used, and an index
 * that names no account resolves to nothing. It never falls back to the
 * default, because quietly answering as a different account than the one the
 * tab asked for is worse than asking the user to choose again. Without an
 * explicit index the session default is used.
 */
export function resolveActiveAccount(
  session: SessionRecord | undefined,
  explicitIndex?: number,
): Resolution {
  if (!session || session.accounts.length === 0) return { kind: 'none', reason: 'no_session' };

  if (explicitIndex !== undefined) {
    const account = session.accounts[explicitIndex];
    if (!account) return { kind: 'none', reason: 'no_such_index' };
    return { kind: 'active', account, index: explicitIndex, explicit: true };
  }

  const index = session.accounts.findIndex((a) => a.accountId === session.defaultAccountId);
  const account = session.accounts[index];
  if (!account) return { kind: 'none', reason: 'no_session' };
  return { kind: 'active', account, index, explicit: false };
}
