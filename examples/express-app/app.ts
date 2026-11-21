import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Response,
} from 'express';

import { getAccounts, multiAccount } from '../../src/express/index.ts';
import {
  MultiAccountError,
  type Clock,
  type KeyRing,
  type SessionManager,
  type SessionStore,
} from '../../src/index.ts';
import {
  STYLESHEET,
  chooserPage,
  homePage,
  loginPage,
  messagePage,
  type DemoUser,
} from './views.ts';

/** The whole "user database". Nothing secret is stored for these users. */
export const DEMO_USERS: readonly DemoUser[] = [
  { id: 'user-ada', name: 'Ada Example', email: 'ada@example.test' },
  { id: 'user-grace', name: 'Grace Sample', email: 'grace@example.test' },
  { id: 'user-edsger', name: 'Edsger Demo', email: 'edsger@example.test' },
];

export interface AppOptions {
  readonly store: SessionStore;
  readonly keys: KeyRing;
  readonly clock?: Clock;
  /**
   * Default true: `__Host-` cookies with the Secure attribute, which need
   * HTTPS. Pass false to try the demo over plain HTTP on localhost.
   */
  readonly secureCookies?: boolean;
}

export interface DemoApp {
  readonly app: Express;
  readonly manager: SessionManager;
}

const NOTICES: Readonly<Record<string, string>> = {
  'signed-out': 'Signed out of that account.',
  default: 'Default account changed.',
  'no-such-account': 'That account is no longer signed in. Choose another.',
};

export function createApp(options: AppOptions): DemoApp {
  const secure = options.secureCookies ?? true;
  const accounts = multiAccount({
    store: options.store,
    keys: options.keys,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(secure ? {} : { cookieName: 'mas', csrfCookieName: 'mas-csrf', cookie: { secure: false } }),
  });

  const app = express();
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      // Pages differ per account, so nothing may be reused from a cache.
      'Cache-Control': 'no-store',
    });
    next();
  });

  app.get('/static/app.css', (_req, res) => {
    res.type('text/css').send(STYLESHEET);
  });

  app.use(accounts.middleware);
  app.use(express.urlencoded({ extended: false, limit: '4kb' }));
  app.use(accounts.csrfProtection);

  app.get('/login', (req, res) => {
    const ctx = getAccounts(req);
    res.send(
      loginPage({
        users: DEMO_USERS,
        signedIn: new Set(ctx.list.map((account) => account.accountId)),
        csrf: ctx.csrfToken(),
        hasAccounts: ctx.list.length > 0,
      }),
    );
  });

  app.post('/login', async (req, res) => {
    const user = DEMO_USERS.find((candidate) => candidate.id === field(req, 'user'));
    if (!user) {
      res.status(400).send(messagePage('Unknown user', 'Pick one of the demo users.'));
      return;
    }
    // A real application authenticates the user here, before signIn.
    const ctx = getAccounts(req);
    const index = await ctx.signIn({
      accountId: user.id,
      profile: { name: user.name, email: user.email },
    });
    res.redirect(303, ctx.pathFor(index));
  });

  app.get('/accounts', (req, res) => {
    const ctx = getAccounts(req);
    if (ctx.list.length === 0) {
      res.redirect(303, '/login');
      return;
    }
    const notice = NOTICES[typeof req.query.notice === 'string' ? req.query.notice : ''];
    res.send(
      chooserPage({
        accounts: ctx.list,
        defaultAccountId: ctx.session?.defaultAccountId,
        csrf: ctx.csrfToken(),
        pathFor: (index, path) => ctx.pathFor(index, path),
        ...(notice ? { notice } : {}),
      }),
    );
  });

  // Account management names the account by id, which is what the user saw
  // next to the button they pressed.
  app.post('/accounts/default', async (req, res) => {
    await getAccounts(req).setDefault(field(req, 'accountId') ?? '');
    res.redirect(303, '/accounts?notice=default');
  });

  app.post('/accounts/sign-out', async (req, res) => {
    const ctx = getAccounts(req);
    await ctx.signOut(field(req, 'accountId') ?? '');
    res.redirect(303, ctx.list.length > 0 ? '/accounts?notice=signed-out' : '/login');
  });

  app.post('/accounts/sign-out-all', async (req, res) => {
    await getAccounts(req).signOutAll();
    res.redirect(303, '/login');
  });

  const signedIn = accounts.requireAccount({
    onMissing: (req, res) => {
      const ctx = getAccounts(req);
      res.redirect(303, ctx.list.length > 0 ? '/accounts?notice=no-such-account' : '/login');
    },
  });

  const renderHome = (page: 'home' | 'profile') => (req: Request, res: Response) => {
    const ctx = getAccounts(req);
    const active = ctx.active;
    if (active.kind !== 'active') {
      res.redirect(303, '/accounts');
      return;
    }
    if (!active.explicit) {
      // Pin the tab to an index so it stays on this account from here on.
      res.redirect(303, ctx.pathFor(active.index, page === 'home' ? '/' : '/profile'));
      return;
    }
    res.send(
      homePage({
        account: active.account,
        others: ctx.list.filter((other) => other.index !== active.index),
        pathFor: (index, path) => ctx.pathFor(index, path),
        page,
        expiresAt: accounts.manager.accountExpiresAt(active.account),
      }),
    );
  };

  app.get('/', signedIn, renderHome('home'));
  app.get('/profile', signedIn, renderHome('profile'));

  app.use((_req, res) => {
    res.status(404).send(messagePage('Not found', 'There is nothing at this address.'));
  });

  const onError: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof MultiAccountError && error.code === 'csrf_failed') {
      res
        .status(403)
        .send(
          messagePage(
            'Request refused',
            'The form was out of date, usually because an account signed in or out in another tab. Go back to the account list and try again.',
          ),
        );
      return;
    }
    if (error instanceof MultiAccountError && error.status !== undefined) {
      res.status(error.status).send(messagePage('Request refused', error.message));
      return;
    }
    console.error(error);
    res
      .status(500)
      .send(messagePage('Something went wrong', 'The request could not be completed.'));
  };
  app.use(onError);

  return { app, manager: accounts.manager };
}

function field(req: Request, name: string): string | undefined {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}
