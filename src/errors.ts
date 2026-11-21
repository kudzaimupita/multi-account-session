export type ErrorCode =
  | 'invalid_key'
  | 'invalid_cookie_options'
  | 'invalid_account'
  | 'too_many_accounts'
  | 'unknown_account'
  | 'no_session'
  | 'csrf_failed'
  | 'store_corrupt'
  | 'not_installed';

const HTTP_STATUS: Partial<Record<ErrorCode, number>> = {
  csrf_failed: 403,
  no_session: 401,
  unknown_account: 404,
  too_many_accounts: 409,
  invalid_account: 400,
};

/**
 * The one error type thrown by this library. `status` is set for errors that
 * map naturally to an HTTP response, so framework error handlers can use it.
 */
export class MultiAccountError extends Error {
  readonly code: ErrorCode;
  readonly status: number | undefined;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'MultiAccountError';
    this.code = code;
    this.status = HTTP_STATUS[code];
  }
}
