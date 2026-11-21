# multi-account-session

Several accounts signed in at once in one browser: an account chooser, a
different account per tab, and signing out of one account without touching the
others. A small TypeScript library with an Express adapter and a runnable
example.

## Why

Most session libraries assume one user per browser. Adding "switch account"
on top usually means stuffing a list into the session and hoping the edge cases
work out: which account does this tab act as after another tab switched, what
happens to the list when one account's session ends, does the session id change
when a second account signs in. This library handles exactly that part and
nothing else. It does not authenticate anyone; the application does that and
then calls `signIn`.

## Quick start

Needs Node 24 or later.

```sh
npm ci
npm run check      # lint, format check, type check, tests, build
npm run example    # demo on http://localhost:3000
```

The demo has three fixed users and no passwords. Sign in as two of them, open
`/u/0/` and `/u/1/` in separate tabs, and each tab stays on its own account.
Stop the server and start it again: both are still signed in, because the demo
uses the file-backed store. The demo serves plain HTTP on localhost, so it uses
cookies without `Secure` and without the `__Host-` prefix; set
`SECURE_COOKIES=1` when running it behind HTTPS.

## Using it

```ts
import express from 'express';
import { FileSessionStore, keyFromString } from 'multi-account-session';
import { getAccounts, multiAccount } from 'multi-account-session/express';

const accounts = multiAccount({
  store: await FileSessionStore.open('./data/sessions.json'),
  keys: { current: keyFromString(process.env.COOKIE_KEY!) }, // 32 random bytes
});

const app = express();
app.use(accounts.middleware);
app.use(express.urlencoded({ extended: false }));
app.use(accounts.csrfProtection);

app.post('/login', async (req, res) => {
  const user = await authenticate(req); // your code
  const index = await getAccounts(req).signIn({
    accountId: user.id,
    profile: { name: user.name },
  });
  res.redirect(303, getAccounts(req).pathFor(index)); // -> /u/<index>/
});

app.get('/inbox', accounts.requireAccount(), (req, res) => {
  const active = getAccounts(req).active; // account for this request
  // Served at /inbox (default account) and /u/1/inbox (account 1).
});

app.post('/logout', async (req, res) => {
  await getAccounts(req).signOut(String(req.body.accountId)); // the others stay
  res.redirect(303, '/accounts');
});
```

`getAccounts(req)` also gives `list`, `setDefault(accountId)`, `signOutAll()`
and `csrfToken()` for forms. The package is not published to npm; it is marked
`private` and meant to be read, cloned or vendored.

Without Express, use the pieces directly: `SessionManager` for the session
operations, `seal`/`unseal` and `serializeCookie`/`readCookie` for the cookie,
`createCsrfToken`/`verifyCsrfRequest` for CSRF.

## How it works

**Session model.** A session is an ordered list of accounts plus a default.
Each account gets an index when it signs in. A request names its account with
a URL prefix (`/u/1/inbox`) or an `X-Account-Index` header; the middleware
strips the prefix so routes are written once. With no index, the default
account is used. An index that names no account resolves to no account, never
to the default.

**Indices are not reused.** If account 0 signs out, account 1 stays at
`/u/1/`. Index 0 is not handed to the next account, so a tab left open on
`/u/0/` gets sent back to the chooser. It does not quietly become someone
else. Indices start again from zero only when the whole session ends.

**Id rotation.** Every sign-in and sign-out moves the session to a new random
256-bit id and deletes the old record first. This is the defence against
session fixation, and it makes cookies captured before a sign-out worthless.
Changing the default does not rotate.

**Expiry.** Each account has its own idle timeout and absolute timeout, checked
on every load against an injectable clock. Expired accounts drop out of the
session individually. Activity is written back at most once a minute per
account so reads do not become writes.

**Cookie.** One cookie holds only the session id, sealed with AES-256-GCM from
`node:crypto` (random 96-bit IV, 128-bit tag, cookie name as associated data).
`keys.previous` lists older keys that still open cookies; anything opened with
one is re-sealed under the current key on that response. Defaults are `Secure`,
`HttpOnly`, `SameSite=Lax`, `Path=/` and the `__Host-` prefix, and a
configuration the browser would reject fails at start-up.

**CSRF.** A signed double-submit token: the request must carry the same token
as the CSRF cookie, and the token must hold a valid HMAC-SHA-256 over a nonce
and the current session id. The HMAC key is derived from the cookie key with
HKDF. Because the token is tied to the session id, a form rendered before an
account signed in or out elsewhere is refused. All comparisons are constant
time.

**Stores.** `SessionStore` has five methods: `get`, `set`, `delete`, `update`
and `deleteExpired`. `update` is an atomic read-modify-write that does nothing
for an unknown id, which is what stops a late activity write from bringing
back a session that was just signed out. Two stores are included:
`MemorySessionStore`, and `FileSessionStore`, which writes a temporary file,
flushes it and renames it over the old one. To check your own store:

```ts
import { describeStoreConformance } from 'multi-account-session/testing';

describeStoreConformance('MyStore', async () => ({ store: new MyStore() }));
```

More detail, including what is deliberately left out, is in
[docs/security.md](docs/security.md).

## Layout

```
src/core/       session manager, index parsing, active-account resolution
src/cookie/     AES-256-GCM sealing, Set-Cookie building, Cookie parsing
src/csrf.ts     token creation and verification
src/stores/     memory and file stores
src/testing/    store conformance suite
src/express/    middleware and request helpers
examples/express-app/   the demo
test/           unit tests and supertest flows
```

## Tests

`npm test` runs 210 tests in 7 files (one more is skipped: the
persistence check does not apply to the memory store). They cover the core
operations, cookie tampering and wrong keys, key rotation, idle and absolute
expiry with a fake clock, CSRF pass and fail cases, session fixation, store
conformance for both stores, and the example app's sign-in, switch and
sign-out flows through supertest.

## Limitations

- It does not authenticate users, rate-limit, or terminate TLS.
- One cookie carries every signed-in account. A stolen cookie exposes all of
  them until they expire or sign out; there is no device binding.
- There is no "sign this account out of every browser". Sessions are looked up
  by session id only.
- Two sign-ins racing in the same browser can lose one of them.
- The file store is for a single process and rewrites the whole file on each
  change. For several instances, implement `SessionStore` over a shared
  database.
- Only an Express adapter is included.
- It has tests but has not had an independent security review.

The full list is under "Known limits" in [docs/security.md](docs/security.md).

## Licence

Apache-2.0. See [LICENSE](LICENSE).
