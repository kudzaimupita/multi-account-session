# Security notes

This document says what `multi-account-session` is meant to protect, how, and
where its protection stops. Read the limits before relying on it.

## What the library holds

- **A session record** in a store on the server: an opaque id, the list of
  signed-in accounts (application account id, URL index, a small display
  profile, sign-in time, last-used time) and which account is the default.
- **One session cookie** in the browser. Its only content is the session id,
  encrypted and authenticated. No account data is in the cookie.
- **One CSRF cookie**, holding a random nonce and a MAC.

The library never sees passwords or any other credential. The application
authenticates the user and then calls `signIn`.

## Threat model

Assets: the ability to act as any account signed in to a browser.

Attackers considered:

1. **A web attacker**: controls other sites the user visits. Can make the
   browser send requests to the application (with cookies, subject to
   SameSite), cannot read responses or cookies.
2. **A cookie-planting attacker**: can write a cookie into the victim's
   browser for the application's host, for instance from a sibling subdomain
   or by handing the victim a prepared browser profile. Cannot read cookies.
3. **A cookie-forging attacker**: can send any bytes as a cookie value, and
   may hold old or stolen-then-revoked cookie values.
4. **Someone who can read the session store** (a leaked backup of the session
   file) but does not have the cookie key.

Out of scope: an attacker who runs script in the application's own origin
(XSS), who controls the user's machine or browser, who can read the cookie key,
or who can read traffic because TLS is missing or broken.

## What it defends against

### Forged, modified or guessed cookies

The session cookie is `v1.<iv>.<ciphertext>.<tag>`, AES-256-GCM from
`node:crypto` with a random 96-bit IV per seal and a full 128-bit tag. The
cookie name is bound in as associated data, so a value sealed for one cookie is
not accepted as another. Anything that fails to authenticate is treated as "no
cookie": no error detail is returned and the request continues signed out.
Session ids are 256 random bits, so guessing one is not practical, and a raw id
is not accepted as a cookie in any case.

Keys must be exactly 32 bytes and are checked at start-up. There is no
password-based key derivation, on purpose: use random keys.

### Key rotation without mass sign-out

`keys.previous` lists keys that are still accepted for opening. New cookies are
always sealed with `keys.current`. A cookie opened with a previous key is
re-issued under the current key on the same response. Removing a key from
`previous` immediately invalidates every cookie still sealed with it.

### Session fixation

Every sign-in and every sign-out moves the session to a new random id and
deletes the old record. If an attacker plants their own valid session cookie in
the victim's browser and the victim then signs in, the victim's account lands
in a session whose id the attacker has never seen, and the id the attacker
holds no longer exists. The same rotation means a cookie value captured before
a sign-out is useless afterwards.

### Cross-site request forgery

State-changing requests must carry a token that passes two checks:

- **Double submit**: the token in the request (header or form field) equals the
  token in the CSRF cookie. Compared in constant time.
- **Signed and bound**: the token is `<nonce>.<HMAC-SHA-256>` where the MAC
  covers the nonce and the current session id. The MAC key is derived from the
  cookie key with HKDF-SHA-256 under a separate label. Compared with
  `timingSafeEqual`.

The first check stops the web attacker, who cannot read the cookie. The second
stops the cookie-planting attacker: a token they minted for their own session
does not verify against the victim's session id, and they cannot mint one for a
session id they do not know. Because the token is bound to the session id, and
the id changes on every sign-in and sign-out, a form rendered before the set of
accounts changed is refused rather than applied to a different set of accounts.

Before anyone is signed in, tokens are bound to "no session". That gives the
sign-in form the double-submit check, which is what protects against login
CSRF (being signed in to the attacker's account without noticing).

The cookies also default to `SameSite=Lax`, which already keeps them off
cross-site POSTs in current browsers. The token is the defence that does not
depend on that.

### Cookie scope

Defaults are `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`, with
the `__Host-` name prefix. The prefix makes the browser refuse the cookie
unless those attributes hold, which stops a sibling subdomain or a plain-HTTP
response from overwriting it. The configuration is validated at start-up:
a `__Host-` name with `secure: false`, a `Domain` or another path throws.

### Acting as the wrong account

- An explicit index that names no account resolves to _no account_. It does
  not fall back to the default.
- Indices are handed out in order and never reused inside a session. If the
  account at `/u/1/` signs out or expires, `/u/1/` stops working. It does not
  start pointing at whichever account was next in the list.
- Only canonical integers `0` to `999` are accepted as an index.

### Expiry

Each account has an idle timeout (default 7 days since last use) and an
absolute timeout (default 30 days since sign-in). They are checked on every
load against the server clock. Expired accounts are removed from the session;
a session with none left is deleted. Activity never extends the absolute
timeout. `manager.sweep()` removes fully expired sessions that nobody has asked
for; call it on a timer.

### Store handling

- A deleted session cannot be brought back by a late write: activity updates
  and default changes go through `store.update`, which does nothing when the
  id is gone. The conformance suite checks this.
- The file store writes a temporary file, flushes it, and renames it over the
  old one, so a crash leaves the old or the new content, not a torn file. The
  file is created with mode `0600`.
- A session file that cannot be parsed makes `FileSessionStore.open` throw. It
  does not silently start empty.
- Someone who reads the store learns session ids and profiles, but cannot turn
  an id into a cookie without the key.

## What is left to the application

- **Authentication.** Verifying passwords, passkeys, OAuth responses, second
  factors. Call `signIn` only after that succeeds.
- **Re-authentication for sensitive actions.** Signing in a second account
  does not prove anything new about the first.
- **Authorisation.** The library says which account a request acts as, not
  what that account may do.
- **Rate limiting and lockout** on sign-in and anywhere else.
- **TLS and HSTS.** `Secure` cookies assume HTTPS end to end.
- **Key management.** Generating keys with a CSPRNG (`generateKey()`), storing
  them in a secret manager, and rotating them.
- **XSS prevention and response headers** (Content-Security-Policy and
  friends). The example app sets a strict policy; the library sets none.
- **Caching.** The same URL can show different accounts depending on the
  cookie. Send `Cache-Control: no-store` (as the example does) or an
  equivalent on per-account responses.
- **Safe methods must be safe.** The CSRF guard skips `GET`, `HEAD` and
  `OPTIONS`. Do not change state in those handlers.
- **Applying the CSRF guard.** It is a middleware you mount; a route registered
  before it is not protected.
- **Audit logging**, and telling users about new sign-ins.
- **Running `sweep()`** and choosing a store that fits the deployment.

## Known limits

- **One cookie carries every account.** Whoever steals the session cookie can
  act as all accounts signed in to that browser until they expire or sign out.
  There is no binding to a device, IP address or TLS channel.
- **XSS defeats it.** Script running in the application's origin cannot read
  the `HttpOnly` cookies, but it can send requests as any signed-in account,
  including choosing the account by URL or header.
- **No server-side "sign out everywhere".** Sessions are keyed by session id
  only. There is no index from an account to all sessions that contain it, so
  revoking an account across browsers (after a password change, say) needs a
  store that can be searched, which the bundled stores are not.
- **Concurrent changes to the same session can lose one of them.** Two
  sign-ins arriving at the same moment from two tabs each rotate from the same
  starting record. The browser keeps whichever cookie arrived last, and the
  other sign-in is lost. The orphaned record stays in the store until it
  expires; its cookie was only ever sent to the same browser. The store
  interface has no compare-and-swap for rotation.
- **Rotation is two store calls.** The old record is deleted, then the new one
  written. A crash in between signs the user out. That order is deliberate (the
  other would leave the old id valid), but it is not atomic.
- **Requests in flight during a rotation** still carry the old cookie and are
  treated as signed out.
- **Indices restart at zero in a new session.** After signing out of all
  accounts, the next sign-in gets index 0 again. A tab left open on `/u/0/`
  from before will then show the new account when reloaded. Indices also run
  out at 999 per session, after which new accounts are refused until all are
  signed out.
- **Idle time is approximate.** Activity is written at most once per
  `touchIntervalMs` (default one minute) per account, so an account can expire
  up to that much earlier than its true last use.
- **AES-GCM with random IVs** should not be used for more than about 2^32
  seals under one key. A seal happens on sign-in, sign-out and re-issue, not on
  every request, so this is far away for most deployments. Rotate keys anyway.
- **The anonymous CSRF token is not tied to a visitor.** Any anonymous token
  is valid for any visitor with no session. The sign-in form is protected by
  the double-submit check alone, which holds as long as an attacker cannot
  write cookies for the host. The `__Host-` prefix is what ensures that; with
  unprefixed cookie names on a domain that has untrusted subdomains, login
  CSRF is possible.
- **Which key opened a cookie is observable by timing.** Keys are tried in
  order. This reveals key age, not key material.
- **The file store is for one process.** It keeps everything in memory,
  rewrites the whole file on each change, and has no locking between
  processes. The memory store loses everything on exit. Neither suits several
  instances behind a load balancer; implement `SessionStore` over a shared
  database for that and run the conformance suite against it.
- **Session ids are stored as they are**, not hashed. A store leak combined
  with a key leak allows cookies to be forged for live sessions.
- **Not audited.** This code has tests, not an independent security review.
