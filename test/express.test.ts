import express, { type ErrorRequestHandler, type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAccounts, multiAccount, type MultiAccountOptions } from '../src/express/index.ts';
import { MemorySessionStore, MultiAccountError, seal, unseal } from '../src/index.ts';
import { DAY, HOUR, MINUTE, fakeClock, testKey, type FakeClock } from './helpers.ts';
import { CookieJar, setCookies } from './jar.ts';

const SESSION = '__Host-mas';
const CSRF = '__Host-mas-csrf';

interface WhoAmI {
  active: string | null;
  index: number | null;
  explicit: boolean | null;
  reason: string | null;
  accounts: string[];
  url: string;
  originalUrl: string;
}

/** A small JSON app that exposes each adapter feature on its own route. */
function buildApp(overrides: Partial<MultiAccountOptions> & Pick<MultiAccountOptions, 'store'>) {
  const accounts = multiAccount({ keys: { current: testKey(1) }, ...overrides });
  const app: Express = express();
  app.use(accounts.middleware);
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get('/csrf', (req, res) => {
    res.json({ token: getAccounts(req).csrfToken() });
  });
  // Sign-in is left outside CSRF protection here to keep the tests short;
  // the example app shows it protected.
  app.post('/sign-in/:id', async (req, res) => {
    const index = await getAccounts(req).signIn({ accountId: req.params.id });
    res.json({ index });
  });

  app.use(accounts.csrfProtection);

  app.get('/whoami', (req, res) => {
    const ctx = getAccounts(req);
    const active = ctx.active;
    const body: WhoAmI = {
      active: active.kind === 'active' ? active.account.accountId : null,
      index: active.kind === 'active' ? active.index : null,
      explicit: active.kind === 'active' ? active.explicit : null,
      reason: active.kind === 'none' ? active.reason : null,
      accounts: ctx.list.map((a) => a.accountId),
      url: req.url,
      originalUrl: req.originalUrl,
    };
    res.json(body);
  });
  app.get('/private', accounts.requireAccount(), (_req, res) => {
    res.json({ ok: true });
  });
  app.post('/default/:id', async (req, res) => {
    await getAccounts(req).setDefault(req.params.id);
    res.json({ ok: true });
  });
  app.post('/sign-out/:id', async (req, res) => {
    await getAccounts(req).signOut(req.params.id);
    res.json({ ok: true });
  });
  app.post('/sign-out-all', async (req, res) => {
    await getAccounts(req).signOutAll();
    res.json({ ok: true });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express needs four parameters
  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    const known = error instanceof MultiAccountError;
    res.status((known && error.status) || 500).json({ code: known ? error.code : 'internal' });
  };
  app.use(onError);
  return app;
}

let store: MemorySessionStore;
let clock: FakeClock;
let app: Express;
let jar: CookieJar;

beforeEach(() => {
  store = new MemorySessionStore();
  clock = fakeClock();
  app = buildApp({ store, clock: clock.now });
  jar = new CookieJar();
});

async function signIn(id: string, target: Express = app, cookies: CookieJar = jar) {
  return cookies.absorb(
    await request(target).post(`/sign-in/${id}`).set('Cookie', cookies.header()),
  );
}

async function whoami(path = '/whoami', target: Express = app, cookies: CookieJar = jar) {
  const response = await request(target).get(path).set('Cookie', cookies.header());
  cookies.absorb(response);
  return response.body as WhoAmI;
}

async function csrfToken(target: Express = app, cookies: CookieJar = jar): Promise<string> {
  const response = cookies.absorb(
    await request(target).get('/csrf').set('Cookie', cookies.header()),
  );
  return (response.body as { token: string }).token;
}

describe('session cookie', () => {
  it('is Secure, HttpOnly, SameSite=Lax, host-only and carries a lifetime', async () => {
    const response = await signIn('ada');
    const cookie = setCookies(response).find((c) => c.startsWith(`${SESSION}=`));
    expect(cookie).toBeDefined();
    const attributes = cookie?.split('; ').slice(1);
    expect(attributes).toEqual([
      'Path=/',
      `Max-Age=${String((30 * DAY) / 1000)}`,
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
    ]);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it('holds nothing but the sealed session id', async () => {
    await signIn('ada');
    const opened = unseal(jar.get(SESSION) ?? '', { current: testKey(1) }, SESSION);
    expect(opened).toBeDefined();
    expect(await store.get(opened?.value ?? '')).toMatchObject({ defaultAccountId: 'ada' });
    expect(jar.get(SESSION)).not.toContain('ada');
  });

  it('sets no cookie for visitors who do nothing', async () => {
    const response = await request(app).get('/whoami');
    expect(setCookies(response)).toEqual([]);
  });

  it('ignores a tampered cookie', async () => {
    await signIn('ada');
    const sealed = jar.get(SESSION) ?? '';
    const middle = Math.floor(sealed.length / 2);
    const swapped = sealed[middle] === 'A' ? 'B' : 'A';
    jar.set(SESSION, sealed.slice(0, middle) + swapped + sealed.slice(middle + 1));
    expect((await whoami()).active).toBeNull();
  });

  it('ignores a cookie sealed with a key the server does not have', async () => {
    await signIn('ada');
    const opened = unseal(jar.get(SESSION) ?? '', { current: testKey(1) }, SESSION);
    jar.set(SESSION, seal(opened?.value ?? '', { current: testKey(7) }, SESSION));
    expect((await whoami()).active).toBeNull();
  });

  it('ignores a raw, unsealed session id', async () => {
    await signIn('ada');
    const opened = unseal(jar.get(SESSION) ?? '', { current: testKey(1) }, SESSION);
    jar.set(SESSION, opened?.value ?? '');
    expect((await whoami()).active).toBeNull();
  });

  it('does not accept the sealed CSRF-cookie context as a session cookie', async () => {
    await signIn('ada');
    const opened = unseal(jar.get(SESSION) ?? '', { current: testKey(1) }, SESSION);
    jar.set(SESSION, seal(opened?.value ?? '', { current: testKey(1) }, CSRF));
    expect((await whoami()).active).toBeNull();
  });

  it('refuses a __Host- cookie configured without Secure', () => {
    expect(() => buildApp({ store, cookie: { secure: false } })).toThrow(/__Host-/);
    expect(() =>
      buildApp({ store, cookie: { secure: false }, cookieName: 'mas', csrfCookieName: 'mas-csrf' }),
    ).not.toThrow();
  });

  it('refuses a key of the wrong size at start-up', () => {
    expect(() => buildApp({ store, keys: { current: Buffer.alloc(8) } })).toThrow(/32 random/);
  });
});

describe('session fixation', () => {
  it('issues a new session id on every sign-in and retires the old cookie', async () => {
    await signIn('ada');
    const first = jar.clone();
    await signIn('grace');
    expect(jar.get(SESSION)).not.toBe(first.get(SESSION));

    const open = (cookies: CookieJar) =>
      unseal(cookies.get(SESSION) ?? '', { current: testKey(1) }, SESSION)?.value;
    expect(open(jar)).not.toBe(open(first));

    expect((await whoami('/whoami', app, jar)).accounts).toEqual(['ada', 'grace']);
    expect((await whoami('/whoami', app, first)).accounts).toEqual([]);
  });

  it('leaves an attacker with nothing after the victim signs in on a planted session', async () => {
    const attacker = new CookieJar();
    await signIn('mallory', app, attacker);
    // The victim's browser is made to carry the attacker's session cookie.
    const victim = attacker.clone();
    await signIn('victim', app, victim);

    expect((await whoami('/whoami', app, victim)).accounts).toEqual(['mallory', 'victim']);
    expect((await whoami('/whoami', app, attacker)).accounts).toEqual([]);
  });

  it('issues a new session id on sign-out and retires the old cookie', async () => {
    await signIn('ada');
    await signIn('grace');
    const before = jar.clone();
    const token = await csrfToken();
    const response = await request(app)
      .post('/sign-out/grace')
      .set('Cookie', jar.header())
      .set('x-csrf-token', token);
    expect(response.status).toBe(200);
    jar.absorb(response);

    expect(jar.get(SESSION)).not.toBe(before.get(SESSION));
    expect((await whoami()).accounts).toEqual(['ada']);
    expect((await whoami('/whoami', app, before)).accounts).toEqual([]);
  });
});

describe('choosing the active account', () => {
  beforeEach(async () => {
    await signIn('ada');
    await signIn('grace');
  });

  it('uses the default account when the URL names none', async () => {
    expect(await whoami()).toMatchObject({ active: 'ada', index: 0, explicit: false });
  });

  it('uses the URL prefix and hides it from routes', async () => {
    expect(await whoami('/u/1/whoami?x=1')).toMatchObject({
      active: 'grace',
      index: 1,
      explicit: true,
      url: '/whoami?x=1',
      originalUrl: '/u/1/whoami?x=1',
    });
    expect(await whoami('/u/0/whoami')).toMatchObject({ active: 'ada', index: 0 });
  });

  it('uses the index header', async () => {
    const response = await request(app)
      .get('/whoami')
      .set('Cookie', jar.header())
      .set('x-account-index', '1');
    expect(response.body).toMatchObject({ active: 'grace', explicit: true });
  });

  it('prefers the URL prefix over the header', async () => {
    const response = await request(app)
      .get('/u/0/whoami')
      .set('Cookie', jar.header())
      .set('x-account-index', '1');
    expect(response.body).toMatchObject({ active: 'ada', index: 0 });
  });

  it('does not fall back to the default for an index with no account', async () => {
    expect(await whoami('/u/5/whoami')).toMatchObject({ active: null, reason: 'no_such_index' });
    const response = await request(app).get('/u/5/private').set('Cookie', jar.header());
    expect(response.status).toBe(401);
  });

  it('ignores a malformed index header', async () => {
    const response = await request(app)
      .get('/whoami')
      .set('Cookie', jar.header())
      .set('x-account-index', '1; drop');
    expect(response.body).toMatchObject({ active: 'ada', explicit: false });
  });

  it('can turn the prefix and header off', async () => {
    const plain = buildApp({ store, clock: clock.now, urlPrefix: false, indexHeader: false });
    const response = await request(plain)
      .get('/whoami')
      .set('Cookie', jar.header())
      .set('x-account-index', '1');
    expect(response.body).toMatchObject({ active: 'ada', explicit: false });
    expect((await request(plain).get('/u/1/whoami').set('Cookie', jar.header())).status).toBe(404);
  });

  it('follows a changed default, while prefixed URLs stay put', async () => {
    const token = await csrfToken();
    await request(app)
      .post('/default/grace')
      .set('Cookie', jar.header())
      .set('x-csrf-token', token)
      .expect(200);
    expect(await whoami()).toMatchObject({ active: 'grace', index: 1, explicit: false });
    expect(await whoami('/u/0/whoami')).toMatchObject({ active: 'ada' });
  });

  it('guards routes with requireAccount', async () => {
    await request(app).get('/private').set('Cookie', jar.header()).expect(200);
    await request(app).get('/private').expect(401);
  });
});

describe('CSRF protection', () => {
  beforeEach(async () => {
    await signIn('ada');
    await signIn('grace');
  });

  const post = (path: string, cookies: CookieJar = jar) =>
    request(app).post(path).set('Cookie', cookies.header());

  it('lets safe methods through without a token', async () => {
    await request(app).get('/whoami').set('Cookie', jar.header()).expect(200);
  });

  it('rejects a state-changing request with no token', async () => {
    await csrfToken();
    const response = await post('/default/grace');
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ code: 'csrf_failed' });
    expect((await whoami()).active).toBe('ada');
  });

  it('accepts the token in a header', async () => {
    const token = await csrfToken();
    await post('/default/grace').set('x-csrf-token', token).expect(200);
    expect((await whoami()).active).toBe('grace');
  });

  it('accepts the token in a form field', async () => {
    const token = await csrfToken();
    await post('/default/grace').type('form').send({ _csrf: token }).expect(200);
  });

  it('accepts the token in a JSON body', async () => {
    const token = await csrfToken();
    await post('/default/grace').send({ _csrf: token }).expect(200);
  });

  it('sets the CSRF cookie HttpOnly, Secure and SameSite=Lax', async () => {
    const response = await request(app).get('/csrf').set('Cookie', jar.header());
    const cookie = setCookies(response).find((c) => c.startsWith(`${CSRF}=`));
    expect(cookie?.split('; ').slice(1)).toEqual(['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']);
  });

  it('reuses the token while the session is unchanged, so tabs do not break each other', async () => {
    const first = await csrfToken();
    const response = await request(app).get('/csrf').set('Cookie', jar.header());
    expect((response.body as { token: string }).token).toBe(first);
    expect(setCookies(response)).toEqual([]);
  });

  it('rejects a token when the cookie is missing (cross-site request without cookies)', async () => {
    const token = await csrfToken();
    jar.delete(CSRF);
    await post('/default/grace').set('x-csrf-token', token).expect(403);
  });

  it('rejects a token that does not match the cookie', async () => {
    const mine = await csrfToken();
    const other = new CookieJar();
    await signIn('edsger', app, other);
    const theirs = await csrfToken(app, other);
    expect(theirs).not.toBe(mine);
    await post('/default/grace').set('x-csrf-token', theirs).expect(403);
  });

  it('rejects a matching cookie and token pair that the server did not sign', async () => {
    await csrfToken();
    const forged = `${'A'.repeat(22)}.${'A'.repeat(43)}`;
    jar.set(CSRF, forged);
    await post('/default/grace').set('x-csrf-token', forged).expect(403);
  });

  it("rejects another session's validly signed pair (cookie planted by an attacker)", async () => {
    const attacker = new CookieJar();
    await signIn('mallory', app, attacker);
    const planted = await csrfToken(app, attacker);
    jar.set(CSRF, planted);
    await post('/default/grace').set('x-csrf-token', planted).expect(403);
  });

  it('retires tokens when the session id changes', async () => {
    const before = await csrfToken();
    await signIn('edsger');
    await post('/default/grace').set('x-csrf-token', before).expect(403);
    const after = await csrfToken();
    expect(after).not.toBe(before);
    await post('/default/grace').set('x-csrf-token', after).expect(200);
  });

  it('protects sign-out and sign-out-all', async () => {
    await csrfToken();
    await post('/sign-out/ada').expect(403);
    await post('/sign-out-all').expect(403);
    expect((await whoami()).accounts).toEqual(['ada', 'grace']);

    const token = await csrfToken();
    jar.absorb(await post('/sign-out-all').set('x-csrf-token', token).expect(200));
    expect(jar.get(SESSION)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('gives anonymous visitors a token that works only while anonymous', async () => {
    const visitor = new CookieJar();
    const token = await csrfToken(app, visitor);
    // No session: a protected POST passes CSRF (and then fails on its own terms).
    const anonymous = await post('/default/x', visitor).set('x-csrf-token', token);
    expect(anonymous.status).toBe(401);
    await signIn('ada', app, visitor);
    await post('/default/ada', visitor).set('x-csrf-token', token).expect(403);
  });
});

describe('key rotation', () => {
  it('accepts a cookie sealed with a previous key and re-issues it under the current key', async () => {
    await signIn('ada');
    const oldCookie = jar.get(SESSION) ?? '';

    const rotated = buildApp({
      store,
      clock: clock.now,
      keys: { current: testKey(2), previous: [testKey(1)] },
    });
    const response = await request(rotated).get('/whoami').set('Cookie', jar.header());
    expect((response.body as WhoAmI).active).toBe('ada');
    jar.absorb(response);

    const newCookie = jar.get(SESSION) ?? '';
    expect(newCookie).not.toBe(oldCookie);
    expect(unseal(newCookie, { current: testKey(2) }, SESSION)?.value).toBe(
      unseal(oldCookie, { current: testKey(1) }, SESSION)?.value,
    );

    // Once the cookie is under the current key it is not sent again.
    const again = await request(rotated).get('/whoami').set('Cookie', jar.header());
    expect(setCookies(again)).toEqual([]);
  });

  it('rejects the old cookie once the previous key is dropped', async () => {
    await signIn('ada');
    const dropped = buildApp({ store, clock: clock.now, keys: { current: testKey(2) } });
    expect((await whoami('/whoami', dropped)).active).toBeNull();
  });

  it('keeps CSRF tokens working across a rotation', async () => {
    await signIn('ada');
    await signIn('grace');
    const token = await csrfToken();
    const rotated = buildApp({
      store,
      clock: clock.now,
      keys: { current: testKey(2), previous: [testKey(1)] },
    });
    await request(rotated)
      .post('/default/grace')
      .set('Cookie', jar.header())
      .set('x-csrf-token', token)
      .expect(200);
    // The next rendered form gets a token under the current key.
    expect(await csrfToken(rotated)).not.toBe(token);
  });
});

describe('expiry through the adapter', () => {
  it('signs an idle account out and keeps an active one', async () => {
    app = buildApp({
      store,
      clock: clock.now,
      session: { idleTimeoutMs: 2 * HOUR, absoluteTimeoutMs: DAY },
    });
    await signIn('ada');
    await signIn('grace');

    // Only grace's tab is used for the next three hours.
    for (let i = 0; i < 6; i += 1) {
      clock.advance(30 * MINUTE);
      expect(await whoami('/u/1/whoami')).toMatchObject({ active: 'grace', index: 1 });
    }
    // Ada has expired. Grace keeps index 1 and becomes the default.
    expect(await whoami()).toMatchObject({ active: 'grace', index: 1, accounts: ['grace'] });
    expect(await whoami('/u/0/whoami')).toMatchObject({ active: null, reason: 'no_such_index' });
  });

  it('ends the session at the absolute timeout despite activity', async () => {
    app = buildApp({
      store,
      clock: clock.now,
      session: { idleTimeoutMs: 2 * HOUR, absoluteTimeoutMs: 6 * HOUR },
    });
    await signIn('ada');
    for (let i = 0; i < 5; i += 1) {
      clock.advance(HOUR);
      expect((await whoami()).active).toBe('ada');
    }
    clock.advance(HOUR);
    expect((await whoami()).active).toBeNull();
    expect(store.size).toBe(0);
  });
});

describe('getAccounts', () => {
  it('fails clearly when the middleware is not installed', async () => {
    const bare = express();
    bare.get('/', (req, res) => {
      res.json(getAccounts(req).list);
    });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express needs four parameters
    const onError: ErrorRequestHandler = (error, _req, res, _next) => {
      res.status(500).json({ code: error instanceof MultiAccountError ? error.code : 'internal' });
    };
    bare.use(onError);
    const response = await request(bare).get('/');
    expect(response.body).toEqual({ code: 'not_installed' });
  });
});
