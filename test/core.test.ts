import { beforeEach, describe, expect, it } from 'vitest';

import {
  MemorySessionStore,
  SessionManager,
  accountPath,
  parseAccountIndex,
  resolveActiveAccount,
  splitAccountPath,
  type SessionRecord,
} from '../src/index.ts';
import { DAY, HOUR, MINUTE, fakeClock, type FakeClock } from './helpers.ts';

let clock: FakeClock;
let store: MemorySessionStore;
let manager: SessionManager;

beforeEach(() => {
  clock = fakeClock();
  store = new MemorySessionStore();
  manager = new SessionManager({
    store,
    clock: clock.now,
    idleTimeoutMs: 2 * HOUR,
    absoluteTimeoutMs: 1 * DAY,
    maxAccounts: 3,
  });
});

const ids = (session: SessionRecord | undefined) => session?.accounts.map((a) => a.accountId);

async function signIn(...accountIds: string[]): Promise<SessionRecord> {
  let session: SessionRecord | undefined;
  for (const accountId of accountIds) {
    ({ session } = await manager.addAccount(session?.id, { accountId }));
  }
  if (!session) throw new Error('signIn needs at least one account');
  return session;
}

describe('adding accounts', () => {
  it('starts a session with the first account as default', async () => {
    const { session, index } = await manager.addAccount(undefined, {
      accountId: 'ada',
      profile: { name: 'Ada' },
    });
    expect(index).toBe(0);
    expect(ids(session)).toEqual(['ada']);
    expect(session.defaultAccountId).toBe('ada');
    expect(session.accounts[0]?.profile).toEqual({ name: 'Ada' });
    expect(await store.get(session.id)).toEqual(session);
  });

  it('appends further accounts in sign-in order and keeps the default', async () => {
    const first = await manager.addAccount(undefined, { accountId: 'ada' });
    const second = await manager.addAccount(first.session.id, { accountId: 'grace' });
    const third = await manager.addAccount(second.session.id, { accountId: 'edsger' });
    expect(second.index).toBe(1);
    expect(third.index).toBe(2);
    expect(ids(third.session)).toEqual(['ada', 'grace', 'edsger']);
    expect(third.session.defaultAccountId).toBe('ada');
  });

  it('refreshes an account that signs in again, in place', async () => {
    const session = await signIn('ada', 'grace');
    clock.advance(HOUR);
    const again = await manager.addAccount(session.id, { accountId: 'ada' });
    expect(again.index).toBe(0);
    expect(ids(again.session)).toEqual(['ada', 'grace']);
    expect(again.session.accounts[0]?.signedInAt).toBe(clock.now());
  });

  it('enforces the account limit', async () => {
    const session = await signIn('a', 'b', 'c');
    await expect(manager.addAccount(session.id, { accountId: 'd' })).rejects.toMatchObject({
      code: 'too_many_accounts',
    });
    expect(ids(await manager.load(session.id))).toEqual(['a', 'b', 'c']);
  });

  it('rejects an empty or oversized account id', async () => {
    await expect(manager.addAccount(undefined, { accountId: '' })).rejects.toMatchObject({
      code: 'invalid_account',
    });
    await expect(
      manager.addAccount(undefined, { accountId: 'x'.repeat(300) }),
    ).rejects.toMatchObject({ code: 'invalid_account' });
  });

  it('starts a fresh session when given an id the store does not know', async () => {
    const { session } = await manager.addAccount('made-up-id', { accountId: 'ada' });
    expect(session.id).not.toBe('made-up-id');
    expect(ids(session)).toEqual(['ada']);
    expect(await store.get('made-up-id')).toBeUndefined();
  });
});

describe('session id rotation', () => {
  it('generates long, unique ids', async () => {
    const a = await signIn('ada');
    const b = await signIn('ada');
    expect(a.id).not.toBe(b.id);
    expect(Buffer.from(a.id, 'base64url').byteLength).toBe(32);
  });

  it('changes the id on every sign-in and invalidates the old one (session fixation)', async () => {
    const first = await manager.addAccount(undefined, { accountId: 'ada' });
    const second = await manager.addAccount(first.session.id, { accountId: 'grace' });
    expect(second.session.id).not.toBe(first.session.id);
    expect(await manager.load(first.session.id)).toBeUndefined();
    expect(store.size).toBe(1);
  });

  it('does not let an attacker who planted a session id keep access after the victim signs in', async () => {
    // The attacker signs in as themselves and plants that session on the victim.
    const planted = await signIn('attacker');
    // The victim adds their own account to it.
    const { session } = await manager.addAccount(planted.id, { accountId: 'victim' });
    // The id the attacker knows no longer leads anywhere.
    expect(await manager.load(planted.id)).toBeUndefined();
    expect(session.id).not.toBe(planted.id);
  });

  it('changes the id when one account signs out', async () => {
    const before = await signIn('ada', 'grace');
    const after = await manager.removeAccount(before.id, 'grace');
    expect(after?.id).not.toBe(before.id);
    expect(await manager.load(before.id)).toBeUndefined();
    expect(ids(after)).toEqual(['ada']);
  });

  it('changes the id when an account signs in again', async () => {
    const before = await signIn('ada');
    const { session } = await manager.addAccount(before.id, { accountId: 'ada' });
    expect(session.id).not.toBe(before.id);
    expect(await manager.load(before.id)).toBeUndefined();
  });

  it('keeps the id when only the default changes', async () => {
    const before = await signIn('ada', 'grace');
    const after = await manager.setDefault(before.id, 'grace');
    expect(after.id).toBe(before.id);
  });
});

describe('removing accounts', () => {
  it('removes one account and leaves the others in order', async () => {
    const session = await signIn('a', 'b', 'c');
    expect(ids(await manager.removeAccount(session.id, 'b'))).toEqual(['a', 'c']);
  });

  it('moves the default to the first remaining account when the default signs out', async () => {
    const session = await signIn('a', 'b', 'c');
    const after = await manager.removeAccount(session.id, 'a');
    expect(after?.defaultAccountId).toBe('b');
  });

  it('keeps the default when another account signs out', async () => {
    let session = await signIn('a', 'b', 'c');
    session = await manager.setDefault(session.id, 'c');
    const after = await manager.removeAccount(session.id, 'a');
    expect(after?.defaultAccountId).toBe('c');
  });

  it('deletes the session when the last account signs out', async () => {
    const session = await signIn('a');
    expect(await manager.removeAccount(session.id, 'a')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('changes nothing when the account is not signed in', async () => {
    const session = await signIn('a', 'b');
    const after = await manager.removeAccount(session.id, 'nobody');
    expect(after).toEqual(session);
  });

  it('removes all accounts at once', async () => {
    const session = await signIn('a', 'b');
    await manager.removeAll(session.id);
    expect(await manager.load(session.id)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('tolerates removing from no session', async () => {
    expect(await manager.removeAccount(undefined, 'a')).toBeUndefined();
    await expect(manager.removeAll(undefined)).resolves.toBeUndefined();
  });
});

describe('default account', () => {
  it('sets the default to a signed-in account', async () => {
    const session = await signIn('a', 'b');
    const after = await manager.setDefault(session.id, 'b');
    expect(after.defaultAccountId).toBe('b');
    expect((await store.get(session.id))?.defaultAccountId).toBe('b');
  });

  it('refuses an account that is not signed in', async () => {
    const session = await signIn('a');
    await expect(manager.setDefault(session.id, 'b')).rejects.toMatchObject({
      code: 'unknown_account',
    });
  });

  it('refuses when there is no session', async () => {
    await expect(manager.setDefault(undefined, 'a')).rejects.toMatchObject({ code: 'no_session' });
    await expect(manager.setDefault('gone', 'a')).rejects.toMatchObject({ code: 'no_session' });
  });
});

describe('resolving the active account', () => {
  it('uses the default when no index is given', async () => {
    let session = await signIn('a', 'b');
    expect(resolveActiveAccount(session)).toMatchObject({
      kind: 'active',
      index: 0,
      explicit: false,
      account: { accountId: 'a' },
    });
    session = await manager.setDefault(session.id, 'b');
    expect(resolveActiveAccount(session)).toMatchObject({ index: 1, account: { accountId: 'b' } });
  });

  it('uses the explicit index over the default', async () => {
    const session = await signIn('a', 'b');
    expect(resolveActiveAccount(session, 1)).toMatchObject({
      kind: 'active',
      index: 1,
      explicit: true,
      account: { accountId: 'b' },
    });
  });

  it('does not fall back to the default for an index that names no account', async () => {
    const session = await signIn('a', 'b');
    expect(resolveActiveAccount(session, 2)).toEqual({ kind: 'none', reason: 'no_such_index' });
    expect(resolveActiveAccount(session, -1)).toEqual({ kind: 'none', reason: 'no_such_index' });
    expect(resolveActiveAccount(session, 0.5)).toEqual({ kind: 'none', reason: 'no_such_index' });
  });

  it('resolves to nothing without a session', () => {
    expect(resolveActiveAccount(undefined)).toEqual({ kind: 'none', reason: 'no_session' });
    expect(resolveActiveAccount(undefined, 0)).toEqual({ kind: 'none', reason: 'no_session' });
  });
});

describe('account index parsing', () => {
  it('accepts canonical non-negative integers only', () => {
    expect(parseAccountIndex('0')).toBe(0);
    expect(parseAccountIndex('12')).toBe(12);
    expect(parseAccountIndex('999')).toBe(999);
    for (const bad of ['', '01', '-1', '+1', '1.0', '1e2', ' 1', '1000', 'one', '0x1']) {
      expect(parseAccountIndex(bad)).toBeUndefined();
    }
    expect(parseAccountIndex(undefined)).toBeUndefined();
  });

  it('splits the index prefix from a URL', () => {
    expect(splitAccountPath('/u/1/inbox?x=1')).toEqual({ index: 1, rest: '/inbox?x=1' });
    expect(splitAccountPath('/u/0')).toEqual({ index: 0, rest: '/' });
    expect(splitAccountPath('/u/2/')).toEqual({ index: 2, rest: '/' });
    expect(splitAccountPath('/u/3?tab=a')).toEqual({ index: 3, rest: '/?tab=a' });
    expect(splitAccountPath('/acct/4/x', 'acct')).toEqual({ index: 4, rest: '/x' });
  });

  it('leaves other URLs alone', () => {
    for (const url of ['/', '/inbox', '/u', '/u/', '/u/x/inbox', '/u/01/', '/users/1', '/u/1x']) {
      expect(splitAccountPath(url)).toBeUndefined();
    }
  });

  it('builds prefixed paths', () => {
    expect(accountPath(1)).toBe('/u/1/');
    expect(accountPath(2, '/settings')).toBe('/u/2/settings');
    expect(accountPath(0, 'settings', 'acct')).toBe('/acct/0/settings');
    expect(() => accountPath(-1)).toThrow(RangeError);
    expect(() => accountPath(1.5)).toThrow(RangeError);
  });
});

describe('expiry', () => {
  it('keeps an account just before the idle timeout and drops it at the timeout', async () => {
    const session = await signIn('a');
    clock.advance(2 * HOUR - 1);
    expect(ids(await manager.load(session.id))).toEqual(['a']);
    clock.advance(1);
    expect(await manager.load(session.id)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('extends the idle timeout when the account is used', async () => {
    let session: SessionRecord | undefined = await signIn('a');
    for (let i = 0; i < 5; i += 1) {
      clock.advance(HOUR);
      session = await manager.load(session?.id);
      session = session && (await manager.touch(session, 'a'));
    }
    expect(ids(session)).toEqual(['a']);
    expect(session?.accounts[0]?.lastActiveAt).toBe(clock.now());
  });

  it('enforces the absolute timeout however active the account is', async () => {
    let session: SessionRecord | undefined = await signIn('a');
    const signedInAt = clock.now();
    while (clock.now() + HOUR < signedInAt + DAY) {
      clock.advance(HOUR);
      session = await manager.load(session?.id);
      session = session && (await manager.touch(session, 'a'));
    }
    expect(ids(session)).toEqual(['a']);
    clock.set(signedInAt + DAY);
    expect(await manager.load(session?.id)).toBeUndefined();
  });

  it('expires accounts independently', async () => {
    const { session: first } = await manager.addAccount(undefined, { accountId: 'a' });
    clock.advance(90 * MINUTE);
    const { session } = await manager.addAccount(first.id, { accountId: 'b' });
    clock.advance(45 * MINUTE);
    // 'a' has been idle 2h15m, 'b' 45m.
    const loaded = await manager.load(session.id);
    expect(ids(loaded)).toEqual(['b']);
    expect(loaded?.defaultAccountId).toBe('b');
    expect(loaded?.id).toBe(session.id);
    expect(ids(await store.get(session.id))).toEqual(['b']);
  });

  it('only touches the account that was used', async () => {
    let session: SessionRecord | undefined = await signIn('a', 'b');
    clock.advance(90 * MINUTE);
    session = await manager.touch(session, 'b');
    clock.advance(45 * MINUTE);
    expect(ids(await manager.load(session?.id))).toEqual(['b']);
  });

  it('restarts both timers when an account signs in again', async () => {
    const session = await signIn('a');
    clock.advance(23 * HOUR);
    // Idle timeout has passed, so this is a fresh sign-in.
    const { session: renewed } = await manager.addAccount(session.id, { accountId: 'a' });
    clock.advance(2 * HOUR - 1);
    expect(ids(await manager.load(renewed.id))).toEqual(['a']);
  });

  it('records activity at most once per touch interval', async () => {
    const session = await signIn('a');
    const start = clock.now();
    clock.advance(MINUTE - 1);
    const early = await manager.touch(session, 'a');
    expect(early?.accounts[0]?.lastActiveAt).toBe(start);
    clock.advance(1);
    const later = await manager.touch(session, 'a');
    expect(later?.accounts[0]?.lastActiveAt).toBe(start + MINUTE);
  });

  it('does not recreate a session that was deleted before a touch landed', async () => {
    const session = await signIn('a');
    clock.advance(10 * MINUTE);
    await manager.removeAll(session.id);
    expect(await manager.touch(session, 'a')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('tracks expiresAt as the latest account expiry and sweeps on it', async () => {
    const session = await signIn('a');
    expect(session.expiresAt).toBe(clock.now() + 2 * HOUR);
    await signIn('b');
    clock.advance(2 * HOUR - 1);
    expect(await manager.sweep()).toBe(0);
    clock.advance(1);
    expect(await manager.sweep()).toBe(2);
    expect(store.size).toBe(0);
  });

  it('caps expiresAt at the absolute timeout', async () => {
    let session: SessionRecord | undefined = await signIn('a');
    const signedInAt = clock.now();
    clock.set(signedInAt + 23 * HOUR + 30 * MINUTE);
    // Keep it alive artificially for this check by touching along the way.
    session = await store.update(session.id, (current) => ({
      ...current,
      accounts: current.accounts.map((a) => ({ ...a, lastActiveAt: clock.now() - MINUTE })),
    }));
    session = session && (await manager.touch(session, 'a'));
    expect(session?.expiresAt).toBe(signedInAt + DAY);
  });

  it('rejects non-positive timeouts', () => {
    expect(() => new SessionManager({ store, idleTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => new SessionManager({ store, absoluteTimeoutMs: -1 })).toThrow(RangeError);
  });
});
