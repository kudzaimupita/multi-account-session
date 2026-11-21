import type { NextFunction, Request, RequestHandler, Response } from 'express';

import {
  assertCookieConfig,
  readCookie,
  serializeClearCookie,
  serializeCookie,
  type CookieOptions,
} from '../cookie/header.ts';
import { assertKeyRing, seal, unseal, type KeyRing } from '../cookie/seal.ts';
import { SessionManager, type SessionManagerOptions } from '../core/manager.ts';
import {
  accountPath,
  parseAccountIndex,
  resolveActiveAccount,
  splitAccountPath,
} from '../core/resolve.ts';
import { createCsrfToken, verifyCsrfRequest, verifyCsrfToken } from '../csrf.ts';
import { MultiAccountError } from '../errors.ts';
import type {
  AccountEntry,
  Clock,
  Resolution,
  SessionRecord,
  SessionStore,
  SignInInput,
} from '../types.ts';

export interface MultiAccountOptions {
  /** 32-byte keys for the session cookie. CSRF keys are derived from them. */
  readonly keys: KeyRing;
  readonly store: SessionStore;
  readonly clock?: Clock;
  /** Expiry and limits, passed to the session manager. */
  readonly session?: Omit<SessionManagerOptions, 'store' | 'clock'>;
  /** Default `__Host-mas`. */
  readonly cookieName?: string;
  /** Default `__Host-mas-csrf`. */
  readonly csrfCookieName?: string;
  /**
   * Cookie attributes. The defaults (Secure, Path=/, no Domain, SameSite=Lax)
   * are what the `__Host-` prefix requires. To serve plain HTTP during
   * development, set `secure: false` and choose cookie names without a prefix.
   */
  readonly cookie?: Pick<CookieOptions, 'secure' | 'sameSite' | 'path' | 'domain'>;
  /** First URL segment that carries the account index: `/u/1/...`. `false` turns it off. */
  readonly urlPrefix?: string | false;
  /** Request header that carries the account index. `false` turns it off. */
  readonly indexHeader?: string | false;
  /** Request header checked for the CSRF token. Default `x-csrf-token`. */
  readonly csrfHeader?: string;
  /** Body field checked for the CSRF token. Default `_csrf`. */
  readonly csrfField?: string;
}

export interface RequireAccountOptions {
  /** Called instead of failing with 401 when the request has no active account. */
  readonly onMissing?: (req: Request, res: Response, next: NextFunction) => void;
}

export interface MultiAccount {
  /** Loads the session and attaches the accounts context. Install it first. */
  readonly middleware: RequestHandler;
  /** Rejects state-changing requests that lack a valid CSRF token with 403. */
  readonly csrfProtection: RequestHandler;
  /** Rejects requests with no active account. */
  requireAccount(options?: RequireAccountOptions): RequestHandler;
  readonly manager: SessionManager;
}

interface Config {
  readonly keys: KeyRing;
  readonly manager: SessionManager;
  readonly cookieName: string;
  readonly csrfCookieName: string;
  readonly sessionCookie: CookieOptions;
  readonly csrfCookie: CookieOptions;
  readonly urlPrefix: string | false;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const contexts = new WeakMap<Request, RequestAccounts>();

/**
 * What a route handler sees: the signed-in accounts, which one this request
 * acts as, and the operations that change them. Operations that change the
 * session set the cookies on the response themselves, so call them before the
 * response is sent.
 */
export class RequestAccounts {
  readonly #config: Config;
  readonly #res: Response;
  readonly #incomingCsrf: string | undefined;
  #session: SessionRecord | undefined;
  #csrf: string | undefined;
  /** Index named by the URL prefix or header, if any. */
  readonly explicitIndex: number | undefined;

  /** @internal */
  constructor(
    config: Config,
    res: Response,
    session: SessionRecord | undefined,
    explicitIndex: number | undefined,
    incomingCsrf: string | undefined,
  ) {
    this.#config = config;
    this.#res = res;
    this.#session = session;
    this.explicitIndex = explicitIndex;
    this.#incomingCsrf = incomingCsrf;
    this.#csrf = incomingCsrf;
  }

  get session(): SessionRecord | undefined {
    return this.#session;
  }

  /** Signed-in accounts in sign-in order. Each carries its own `index`. */
  get list(): readonly AccountEntry[] {
    return this.#session?.accounts ?? [];
  }

  /** The account this request acts as. */
  get active(): Resolution {
    return resolveActiveAccount(this.#session, this.explicitIndex);
  }

  /** Index of the session default, or `undefined` when nobody is signed in. */
  get defaultIndex(): number | undefined {
    const resolved = resolveActiveAccount(this.#session);
    return resolved.kind === 'active' ? resolved.index : undefined;
  }

  /**
   * Add an account after the application has authenticated it. Resolves to
   * the account's index. The session moves to a new id.
   */
  async signIn(input: SignInInput): Promise<number> {
    const { session, index } = await this.#config.manager.addAccount(this.#session?.id, input);
    this.#replaceSession(session);
    return index;
  }

  /** Sign one account out. The others stay, under a new session id. */
  async signOut(accountId: string): Promise<void> {
    const before = this.#session?.id;
    const session = await this.#config.manager.removeAccount(before, accountId);
    if (session?.id !== before) this.#replaceSession(session);
  }

  /** Sign every account out. */
  async signOutAll(): Promise<void> {
    await this.#config.manager.removeAll(this.#session?.id);
    this.#replaceSession(undefined);
  }

  /** Choose which account is used when the URL names none. */
  async setDefault(accountId: string): Promise<void> {
    this.#session = await this.#config.manager.setDefault(this.#session?.id, accountId);
  }

  /**
   * The CSRF token to put in forms (or hand to client code for a header).
   * Also sets the matching cookie when a new token is needed, so call this
   * before sending the response.
   */
  csrfToken(): string {
    const { keys, csrfCookieName, csrfCookie } = this.#config;
    if (this.#csrf && verifyCsrfToken({ current: keys.current }, this.#session?.id, this.#csrf)) {
      return this.#csrf;
    }
    const token = createCsrfToken(keys, this.#session?.id);
    setCookieHeader(this.#res, csrfCookieName, serializeCookie(csrfCookieName, token, csrfCookie));
    this.#csrf = token;
    return token;
  }

  /** Check a submitted token against the cookie the request arrived with. */
  verifyCsrf(submitted: string | undefined): boolean {
    return verifyCsrfRequest(this.#config.keys, this.#session?.id, this.#incomingCsrf, submitted);
  }

  /** A path that pins the given account index, such as `/u/1/settings`. */
  pathFor(index: number, path = '/'): string {
    const prefix = this.#config.urlPrefix;
    return prefix === false ? path : accountPath(index, path, prefix);
  }

  /** @internal Send the session cookie again, sealed with the current key. */
  reissueCookie(): void {
    this.#writeSessionCookie();
  }

  /** @internal */
  adopt(session: SessionRecord | undefined): void {
    this.#session = session;
  }

  #replaceSession(session: SessionRecord | undefined): void {
    this.#session = session;
    // Tokens are bound to the session id, so the old one is now useless.
    this.#csrf = undefined;
    this.#writeSessionCookie();
  }

  #writeSessionCookie(): void {
    const { keys, cookieName, sessionCookie } = this.#config;
    const header = this.#session
      ? serializeCookie(cookieName, seal(this.#session.id, keys, cookieName), sessionCookie)
      : serializeClearCookie(cookieName, sessionCookie);
    setCookieHeader(this.#res, cookieName, header);
  }
}

/** Replace any pending `Set-Cookie` for `name` on this response, keeping the others. */
function setCookieHeader(res: Response, name: string, header: string): void {
  const current = res.getHeader('Set-Cookie');
  const existing =
    current === undefined ? [] : Array.isArray(current) ? current : [String(current)];
  res.setHeader('Set-Cookie', [...existing.filter((h) => !h.startsWith(`${name}=`)), header]);
}

/** The accounts context for a request. Throws if the middleware is not installed. */
export function getAccounts(req: Request): RequestAccounts {
  const context = contexts.get(req);
  if (!context) {
    throw new MultiAccountError(
      'not_installed',
      'multi-account middleware has not run for this request',
    );
  }
  return context;
}

/** Wire the library into an Express application. */
export function multiAccount(options: MultiAccountOptions): MultiAccount {
  assertKeyRing(options.keys);
  const cookieName = options.cookieName ?? '__Host-mas';
  const csrfCookieName = options.csrfCookieName ?? '__Host-mas-csrf';
  if (cookieName === csrfCookieName) {
    throw new MultiAccountError('invalid_cookie_options', 'cookie names must differ');
  }
  const manager = new SessionManager({
    ...options.session,
    store: options.store,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const csrfCookie: CookieOptions = { ...options.cookie, httpOnly: true };
  const sessionCookie: CookieOptions = {
    ...csrfCookie,
    maxAgeSeconds: manager.absoluteTimeoutMs / 1000,
  };
  assertCookieConfig(cookieName, sessionCookie);
  assertCookieConfig(csrfCookieName, csrfCookie);

  const config: Config = {
    keys: options.keys,
    manager,
    cookieName,
    csrfCookieName,
    sessionCookie,
    csrfCookie,
    urlPrefix: options.urlPrefix ?? 'u',
  };
  const indexHeader = options.indexHeader ?? 'x-account-index';
  const csrfHeader = options.csrfHeader ?? 'x-csrf-token';
  const csrfField = options.csrfField ?? '_csrf';

  const load = async (req: Request, res: Response): Promise<void> => {
    let explicitIndex: number | undefined;
    if (config.urlPrefix !== false) {
      const split = splitAccountPath(req.url, config.urlPrefix);
      if (split) {
        explicitIndex = split.index;
        // Routes are written once, without the prefix.
        req.url = split.rest;
      }
    }
    if (explicitIndex === undefined && indexHeader !== false) {
      explicitIndex = parseAccountIndex(req.get(indexHeader));
    }

    const cookieHeader = req.headers.cookie;
    const sealed = readCookie(cookieHeader, cookieName);
    const opened = sealed === undefined ? undefined : unseal(sealed, config.keys, cookieName);
    const session = await manager.load(opened?.value);

    const context = new RequestAccounts(
      config,
      res,
      session,
      explicitIndex,
      readCookie(cookieHeader, csrfCookieName),
    );
    contexts.set(req, context);

    if (session && opened?.usedPreviousKey) context.reissueCookie();

    const active = context.active;
    if (session && active.kind === 'active') {
      context.adopt(await manager.touch(session, active.account.accountId));
    }
  };

  const middleware: RequestHandler = (req, res, next) => {
    load(req, res).then(() => {
      next();
    }, next);
  };

  const csrfProtection: RequestHandler = (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const submitted = req.get(csrfHeader) ?? bodyField(req.body, csrfField);
    if (getAccounts(req).verifyCsrf(submitted)) {
      next();
      return;
    }
    next(new MultiAccountError('csrf_failed', 'missing or invalid CSRF token'));
  };

  const requireAccount = (requireOptions: RequireAccountOptions = {}): RequestHandler => {
    return (req, res, next) => {
      if (getAccounts(req).active.kind === 'active') {
        next();
      } else if (requireOptions.onMissing) {
        requireOptions.onMissing(req, res, next);
      } else {
        next(new MultiAccountError('no_session', 'sign-in required'));
      }
    };
  };

  return { middleware, csrfProtection, requireAccount, manager };
}

function bodyField(body: unknown, field: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}
