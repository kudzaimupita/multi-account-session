import type { AccountEntry } from '../../src/index.ts';

export interface DemoUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const e = escapeHtml;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)} · multi-account demo</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<header class="bar">
  <a class="brand" href="/accounts">multi-account-session</a>
  <span class="label">demo</span>
</header>
<main>
${body}
</main>
</body>
</html>
`;
}

function initial(account: AccountEntry): string {
  return e((account.profile.name ?? account.accountId).slice(0, 1).toUpperCase());
}

function hidden(csrf: string, accountId?: string): string {
  const account =
    accountId === undefined ? '' : `<input type="hidden" name="accountId" value="${e(accountId)}">`;
  return `<input type="hidden" name="_csrf" value="${e(csrf)}">${account}`;
}

export interface ChooserView {
  readonly accounts: readonly AccountEntry[];
  readonly defaultAccountId: string | undefined;
  readonly csrf: string;
  readonly pathFor: (index: number, path?: string) => string;
  readonly notice?: string;
}

export function chooserPage(view: ChooserView): string {
  const rows = view.accounts
    .map((account) => {
      const isDefault = account.accountId === view.defaultAccountId;
      return `<li class="row">
    <a class="who" href="${e(view.pathFor(account.index))}">
      <span class="avatar" aria-hidden="true">${initial(account)}</span>
      <span class="names">
        <span class="name">${e(account.profile.name ?? account.accountId)}</span>
        <span class="sub">${e(account.profile.email ?? '')}</span>
      </span>
    </a>
    <span class="meta">
      <span class="label">/u/${account.index}</span>
      ${isDefault ? '<span class="tag">default</span>' : ''}
    </span>
    <span class="actions">
      ${
        isDefault
          ? ''
          : `<form method="post" action="/accounts/default">${hidden(view.csrf, account.accountId)}<button type="submit">Make default</button></form>`
      }
      <form method="post" action="/accounts/sign-out">${hidden(view.csrf, account.accountId)}<button type="submit">Sign out</button></form>
    </span>
  </li>`;
    })
    .join('\n');

  const list =
    view.accounts.length === 0
      ? '<p class="empty">Nobody is signed in.</p>'
      : `<ul class="rows">\n${rows}\n</ul>`;

  const signOutAll =
    view.accounts.length === 0
      ? ''
      : `<form method="post" action="/accounts/sign-out-all">${hidden(view.csrf)}<button type="submit">Sign out of all accounts</button></form>`;

  return layout(
    'Choose an account',
    `<h1>Choose an account</h1>
${view.notice ? `<p class="notice">${e(view.notice)}</p>` : ''}
<p class="lede">Each account has its own URL prefix. Open two in separate tabs and each tab keeps its own account.</p>
${list}
<div class="footer-actions">
  <a class="button primary" href="/login">Add another account</a>
  ${signOutAll}
</div>`,
  );
}

export interface LoginView {
  readonly users: readonly DemoUser[];
  readonly signedIn: ReadonlySet<string>;
  readonly csrf: string;
  readonly hasAccounts: boolean;
}

export function loginPage(view: LoginView): string {
  const rows = view.users
    .map((user) => {
      const already = view.signedIn.has(user.id);
      return `<li class="row">
    <span class="who">
      <span class="avatar" aria-hidden="true">${e(user.name.slice(0, 1))}</span>
      <span class="names">
        <span class="name">${e(user.name)}</span>
        <span class="sub">${e(user.email)}</span>
      </span>
    </span>
    <span class="meta">${already ? '<span class="tag">signed in</span>' : ''}</span>
    <span class="actions">
      <form method="post" action="/login">${hidden(view.csrf)}<input type="hidden" name="user" value="${e(user.id)}"><button type="submit" class="primary">${already ? 'Sign in again' : 'Sign in'}</button></form>
    </span>
  </li>`;
    })
    .join('\n');

  return layout(
    'Sign in',
    `<h1>Sign in</h1>
<p class="lede">A stand-in for real authentication: pick a demo user. There are no passwords here. A real application would verify the user before calling <code>signIn</code>.</p>
<ul class="rows">
${rows}
</ul>
${view.hasAccounts ? '<div class="footer-actions"><a class="button" href="/accounts">Back to accounts</a></div>' : ''}`,
  );
}

export interface HomeView {
  readonly account: AccountEntry;
  readonly others: readonly AccountEntry[];
  readonly pathFor: (index: number, path?: string) => string;
  readonly page: 'home' | 'profile';
  readonly expiresAt: number;
}

export function homePage(view: HomeView): string {
  const { account } = view;
  const index = account.index;
  const name = account.profile.name ?? account.accountId;
  const tabs = `<nav class="tabs">
  <a href="${e(view.pathFor(index, '/'))}"${view.page === 'home' ? ' aria-current="page"' : ''}>Home</a>
  <a href="${e(view.pathFor(index, '/profile'))}"${view.page === 'profile' ? ' aria-current="page"' : ''}>Profile</a>
  <a href="/accounts">Accounts</a>
</nav>`;

  const others =
    view.others.length === 0
      ? '<p class="empty">No other accounts are signed in.</p>'
      : `<ul class="rows">${view.others
          .map(
            (other) => `<li class="row">
    <a class="who" href="${e(view.pathFor(other.index))}">
      <span class="avatar" aria-hidden="true">${initial(other)}</span>
      <span class="names">
        <span class="name">${e(other.profile.name ?? other.accountId)}</span>
        <span class="sub">${e(other.profile.email ?? '')}</span>
      </span>
    </a>
    <span class="meta"><span class="label">/u/${other.index}</span></span>
  </li>`,
          )
          .join('')}</ul>`;

  const body =
    view.page === 'home'
      ? `<h1>Hello, ${e(name)}</h1>
<p class="lede">This tab acts as account <code>/u/${index}</code>. Links on this page keep that prefix, so switching the default elsewhere does not change who this tab is.</p>
<h2>Switch to</h2>
${others}`
      : `<h1>Profile</h1>
<dl class="facts">
  <div><dt>name</dt><dd>${e(name)}</dd></div>
  <div><dt>email</dt><dd>${e(account.profile.email ?? '')}</dd></div>
  <div><dt>account id</dt><dd>${e(account.accountId)}</dd></div>
  <div><dt>index</dt><dd>${index}</dd></div>
  <div><dt>signed in</dt><dd>${e(new Date(account.signedInAt).toISOString())}</dd></div>
  <div><dt>last active</dt><dd>${e(new Date(account.lastActiveAt).toISOString())}</dd></div>
  <div><dt>expires if idle</dt><dd>${e(new Date(view.expiresAt).toISOString())}</dd></div>
</dl>`;

  return layout(name, `${tabs}\n${body}`);
}

export function messagePage(title: string, message: string): string {
  return layout(
    title,
    `<h1>${e(title)}</h1>
<p class="lede">${e(message)}</p>
<div class="footer-actions"><a class="button" href="/accounts">Go to accounts</a></div>`,
  );
}

export const STYLESHEET = `:root {
  --bg: #0b0d0c;
  --panel: #101312;
  --line: #242a27;
  --text: #e6ebe8;
  --muted: #8b9690;
  --accent: #3ddc84;
  --radius: 3px;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body {
  margin: 0;
  color: var(--text);
  font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
}
a { color: inherit; }
code, .label, .tag, dt, .brand, .tabs a { font-family: var(--mono); }
code { font-size: 0.875em; color: var(--accent); }
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--line);
}
.brand { font-size: 13px; letter-spacing: 0.02em; text-decoration: none; }
.label { font-size: 12px; color: var(--muted); letter-spacing: 0.04em; }
main { max-width: 720px; margin: 0 auto; padding: 56px 24px 96px; }
h1 { margin: 0 0 12px; font-size: 28px; font-weight: 600; letter-spacing: -0.01em; }
h2 {
  margin: 48px 0 12px;
  font: 12px var(--mono);
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.lede { margin: 0 0 32px; color: var(--muted); max-width: 60ch; }
.notice {
  margin: 0 0 24px;
  padding: 10px 14px;
  border: 1px solid var(--line);
  border-left: 2px solid var(--accent);
  border-radius: var(--radius);
  font-size: 14px;
}
.empty {
  margin: 0;
  padding: 24px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  color: var(--muted);
  font-size: 14px;
}
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel);
}
.row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 16px;
  border-top: 1px solid var(--line);
}
.row:first-child { border-top: 0; }
.who {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1 1 auto;
  min-width: 0;
  text-decoration: none;
}
a.who:hover .name { color: var(--accent); }
.avatar {
  flex: none;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  font: 13px var(--mono);
  color: var(--accent);
}
.names { display: grid; min-width: 0; }
.name, .sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub { font-size: 13px; color: var(--muted); }
.meta { display: flex; align-items: center; gap: 10px; flex: none; }
.tag {
  padding: 1px 6px;
  border: 1px solid var(--accent);
  border-radius: 2px;
  color: var(--accent);
  font-size: 11px;
  letter-spacing: 0.04em;
}
.actions { display: flex; gap: 8px; flex: none; }
form { margin: 0; }
button, .button {
  display: inline-block;
  padding: 7px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: transparent;
  color: var(--text);
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
}
button:hover, .button:hover { border-color: var(--muted); }
button.primary, .button.primary { border-color: var(--accent); color: var(--accent); }
button:focus-visible, a:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
.footer-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 32px; }
.tabs {
  display: flex;
  gap: 24px;
  margin: 0 0 40px;
  border-bottom: 1px solid var(--line);
}
.tabs a {
  padding: 0 0 10px;
  margin-bottom: -1px;
  border-bottom: 1px solid transparent;
  color: var(--muted);
  font-size: 13px;
  text-decoration: none;
}
.tabs a:hover { color: var(--text); }
.tabs a[aria-current="page"] { color: var(--accent); border-bottom-color: var(--accent); }
.facts { margin: 24px 0 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); }
.facts div { display: flex; gap: 16px; padding: 12px 16px; border-top: 1px solid var(--line); }
.facts div:first-child { border-top: 0; }
dt { flex: 0 0 140px; font-size: 12px; color: var(--muted); padding-top: 2px; }
dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
@media (max-width: 560px) {
  .bar { padding: 14px 16px; }
  main { padding: 32px 16px 64px; }
  h1 { font-size: 23px; }
  .row { flex-wrap: wrap; gap: 12px; }
  .who { flex-basis: 60%; }
  .actions { flex-basis: 100%; }
  .actions form, .actions button { flex: 1 1 auto; width: 100%; }
  .footer-actions > *, .footer-actions button { width: 100%; text-align: center; }
  .facts div { flex-direction: column; gap: 2px; }
  dt { flex-basis: auto; }
}
`;
