import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Express } from 'express';
import request, { type Response } from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../examples/express-app/app.ts';
import { chooserPage } from '../examples/express-app/views.ts';
import { FileSessionStore, MemorySessionStore } from '../src/index.ts';
import { testKey } from './helpers.ts';
import { CookieJar } from './jar.ts';

const keys = { current: testKey(3) };
const SESSION = '__Host-mas';

/** Drives the example app the way one browser profile would. */
class Browser {
  readonly jar = new CookieJar();
  readonly #app: Express;

  constructor(app: Express) {
    this.#app = app;
  }

  async get(path: string): Promise<Response> {
    return this.jar.absorb(await request(this.#app).get(path).set('Cookie', this.jar.header()));
  }

  /** GET and follow redirects, as a browser tab does. Returns the final response and path. */
  async visit(path: string): Promise<{ response: Response; path: string }> {
    let current = path;
    for (let hops = 0; hops < 5; hops += 1) {
      const response = await this.get(current);
      if (response.status < 300 || response.status >= 400) return { response, path: current };
      current = String(response.headers.location);
    }
    throw new Error(`too many redirects from ${path}`);
  }

  async post(path: string, fields: Record<string, string>): Promise<Response> {
    return this.jar.absorb(
      await request(this.#app)
        .post(path)
        .set('Cookie', this.jar.header())
        .type('form')
        .send(fields),
    );
  }

  /** Read the CSRF token out of a rendered form, as submitting the form would. */
  async tokenFrom(path: string): Promise<string> {
    const { response } = await this.visit(path);
    const match = /name="_csrf" value="([^"]+)"/.exec(response.text);
    if (!match?.[1]) throw new Error(`no CSRF field on ${path}`);
    return match[1];
  }

  async signIn(user: string): Promise<Response> {
    return this.post('/login', { _csrf: await this.tokenFrom('/login'), user });
  }
}

let app: Express;
let browser: Browser;

beforeEach(() => {
  ({ app } = createApp({ store: new MemorySessionStore(), keys }));
  browser = new Browser(app);
});

describe('example app: signing in', () => {
  it('sends a new visitor to the sign-in page', async () => {
    const { response, path } = await browser.visit('/');
    expect(path).toBe('/login');
    expect(response.text).toContain('Ada Example');
    expect(response.text).toContain('Grace Sample');
  });

  it('signs in a demo user and lands on their prefixed home', async () => {
    const response = await browser.signIn('user-ada');
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('/u/0/');
    const home = await browser.get('/u/0/');
    expect(home.status).toBe(200);
    expect(home.text).toContain('Hello, Ada Example');
  });

  it('rejects sign-in without a CSRF token', async () => {
    await browser.get('/login');
    const response = await browser.post('/login', { user: 'user-ada' });
    expect(response.status).toBe(403);
    expect(browser.jar.get(SESSION)).toBeUndefined();
  });

  it('rejects an unknown user', async () => {
    const response = await browser.post('/login', {
      _csrf: await browser.tokenFrom('/login'),
      user: 'user-nobody',
    });
    expect(response.status).toBe(400);
    expect(browser.jar.get(SESSION)).toBeUndefined();
  });

  it('changes the session cookie on each sign-in', async () => {
    await browser.signIn('user-ada');
    const first = browser.jar.get(SESSION);
    const second = await browser.signIn('user-grace');
    expect(second.headers.location).toBe('/u/1/');
    expect(browser.jar.get(SESSION)).toBeDefined();
    expect(browser.jar.get(SESSION)).not.toBe(first);
  });

  it('pins an unprefixed visit to the default account', async () => {
    await browser.signIn('user-ada');
    await browser.signIn('user-grace');
    const response = await browser.get('/profile');
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('/u/0/profile');
  });
});

describe('example app: several accounts', () => {
  beforeEach(async () => {
    await browser.signIn('user-ada');
    await browser.signIn('user-grace');
  });

  it('lists every signed-in account in the chooser', async () => {
    const chooser = await browser.get('/accounts');
    expect(chooser.status).toBe(200);
    expect(chooser.text).toContain('href="/u/0/"');
    expect(chooser.text).toContain('href="/u/1/"');
    expect(chooser.text).toContain('ada@example.test');
    expect(chooser.text).toContain('grace@example.test');
    expect(chooser.text.match(/class="tag">default</g)).toHaveLength(1);
  });

  it('serves a different account per URL prefix with the same cookie', async () => {
    expect((await browser.get('/u/0/')).text).toContain('Hello, Ada Example');
    expect((await browser.get('/u/1/')).text).toContain('Hello, Grace Sample');
    expect((await browser.get('/u/1/profile')).text).toContain('grace@example.test');
  });

  it("keeps links on a page inside that page's account", async () => {
    const home = await browser.get('/u/1/');
    expect(home.text).toContain('href="/u/1/profile"');
    expect(home.text).not.toContain('href="/u/0/profile"');
  });

  it('switches the default account', async () => {
    const token = await browser.tokenFrom('/accounts');
    const response = await browser.post('/accounts/default', {
      _csrf: token,
      accountId: 'user-grace',
    });
    expect(response.status).toBe(303);
    expect((await browser.get('/')).headers.location).toBe('/u/1/');
    // A tab already on /u/0/ is unaffected.
    expect((await browser.get('/u/0/')).text).toContain('Hello, Ada Example');
  });

  it('refuses to switch the default without a valid token', async () => {
    await browser.get('/accounts');
    const missing = await browser.post('/accounts/default', { accountId: 'user-grace' });
    expect(missing.status).toBe(403);
    const wrong = await browser.post('/accounts/default', {
      _csrf: 'AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      accountId: 'user-grace',
    });
    expect(wrong.status).toBe(403);
    expect((await browser.get('/')).headers.location).toBe('/u/0/');
  });

  it('refuses to make a signed-out account the default', async () => {
    const response = await browser.post('/accounts/default', {
      _csrf: await browser.tokenFrom('/accounts'),
      accountId: 'user-edsger',
    });
    expect(response.status).toBe(404);
  });

  it('signs out one account and keeps the other', async () => {
    const before = browser.jar.get(SESSION);
    const response = await browser.post('/accounts/sign-out', {
      _csrf: await browser.tokenFrom('/accounts'),
      accountId: 'user-ada',
    });
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('/accounts?notice=signed-out');
    expect(browser.jar.get(SESSION)).not.toBe(before);

    const chooser = await browser.get('/accounts?notice=signed-out');
    expect(chooser.text).toContain('Signed out of that account.');
    expect(chooser.text).toContain('grace@example.test');
    expect(chooser.text).not.toContain('ada@example.test');
    // Grace keeps her index and is the default now.
    expect((await browser.get('/')).headers.location).toBe('/u/1/');
    expect((await browser.get('/u/1/')).text).toContain('Hello, Grace Sample');
  });

  it('sends a tab whose index no longer exists back to the chooser', async () => {
    await browser.post('/accounts/sign-out', {
      _csrf: await browser.tokenFrom('/accounts'),
      accountId: 'user-ada',
    });
    const stale = await browser.get('/u/0/');
    expect(stale.status).toBe(303);
    expect(stale.headers.location).toBe('/accounts?notice=no-such-account');
  });

  it('never shows a tab a different account than the one it was opened for', async () => {
    await browser.post('/accounts/sign-out', {
      _csrf: await browser.tokenFrom('/accounts'),
      accountId: 'user-ada',
    });
    const added = await browser.signIn('user-edsger');
    expect(added.headers.location).toBe('/u/2/');
    // Index 0 was Ada's. It is not handed to anyone else.
    expect((await browser.get('/u/0/')).status).toBe(303);
    expect((await browser.get('/u/1/')).text).toContain('Hello, Grace Sample');
  });

  it('refuses a form rendered before another tab changed the session', async () => {
    const staleToken = await browser.tokenFrom('/accounts');
    await browser.signIn('user-edsger');
    const response = await browser.post('/accounts/sign-out', {
      _csrf: staleToken,
      accountId: 'user-ada',
    });
    expect(response.status).toBe(403);
    expect(response.text).toContain('out of date');
  });

  it('refuses sign-out without a token', async () => {
    await browser.get('/accounts');
    const response = await browser.post('/accounts/sign-out', { accountId: 'user-ada' });
    expect(response.status).toBe(403);
    expect((await browser.get('/u/0/')).text).toContain('Hello, Ada Example');
  });

  it('signs out of everything and clears the cookie', async () => {
    const old = browser.jar.clone();
    const response = await browser.post('/accounts/sign-out-all', {
      _csrf: await browser.tokenFrom('/accounts'),
    });
    expect(response.headers.location).toBe('/login');
    expect(browser.jar.get(SESSION)).toBeUndefined();
    expect((await browser.visit('/')).path).toBe('/login');

    // The cookie from before sign-out is dead on the server too.
    const replay = await request(app).get('/u/0/').set('Cookie', old.header());
    expect(replay.headers.location).toBe('/login');
  });

  it('goes to sign-in after the last account signs out', async () => {
    await browser.post('/accounts/sign-out', {
      _csrf: await browser.tokenFrom('/accounts'),
      accountId: 'user-ada',
    });
    const last = await browser.post('/accounts/sign-out', {
      _csrf: await browser.tokenFrom('/accounts'),
      accountId: 'user-grace',
    });
    expect(last.headers.location).toBe('/login');
    expect(browser.jar.get(SESSION)).toBeUndefined();
  });
});

describe('example app: pages', () => {
  it('sets defensive headers', async () => {
    const response = await browser.get('/login');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('escapes account data and tokens in rendered pages', () => {
    const html = chooserPage({
      accounts: [
        {
          accountId: '"><script>alert(1)</script>',
          index: 0,
          profile: { name: '<img src=x onerror=alert(1)>', email: 'a&b@example.test' },
          signedInAt: 0,
          lastActiveAt: 0,
        },
      ],
      defaultAccountId: undefined,
      csrf: '"><script>',
      pathFor: (index) => `/u/${String(index)}/`,
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('a&amp;b@example.test');
  });

  it('serves the stylesheet and a 404 page', async () => {
    const css = await browser.get('/static/app.css');
    expect(css.headers['content-type']).toContain('text/css');
    expect((await browser.get('/nope')).status).toBe(404);
  });
});

describe('example app: restart with the file store', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mas-example-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps accounts signed in when the process is replaced', async () => {
    const path = join(directory, 'sessions.json');
    const first = createApp({ store: await FileSessionStore.open(path), keys });
    const before = new Browser(first.app);
    await before.signIn('user-ada');
    await before.signIn('user-grace');

    // A new process: new store instance over the same file, same key.
    const second = createApp({ store: await FileSessionStore.open(path), keys });
    const response = await request(second.app).get('/u/1/').set('Cookie', before.jar.header());
    expect(response.status).toBe(200);
    expect(response.text).toContain('Hello, Grace Sample');
  });
});
