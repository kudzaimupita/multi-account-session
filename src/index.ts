export { MultiAccountError, type ErrorCode } from './errors.ts';
export type {
  AccountEntry,
  AccountProfile,
  Clock,
  Resolution,
  SessionRecord,
  SessionStore,
  SignInInput,
} from './types.ts';
export {
  SessionManager,
  generateSessionId,
  type SessionManagerOptions,
  type SignInResult,
} from './core/manager.ts';
export {
  MAX_ACCOUNT_INDEX,
  accountPath,
  parseAccountIndex,
  resolveActiveAccount,
  splitAccountPath,
  type PathIndex,
} from './core/resolve.ts';
export {
  assertKeyRing,
  generateKey,
  keyFromString,
  seal,
  unseal,
  type KeyRing,
  type Unsealed,
} from './cookie/seal.ts';
export {
  assertCookieConfig,
  readCookie,
  serializeClearCookie,
  serializeCookie,
  type CookieOptions,
} from './cookie/header.ts';
export { constantTimeEqual, createCsrfToken, verifyCsrfRequest, verifyCsrfToken } from './csrf.ts';
export { MemorySessionStore } from './stores/memory.ts';
export { FileSessionStore } from './stores/file.ts';
