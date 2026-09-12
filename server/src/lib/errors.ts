/**
 * Structured application errors.
 *
 * Every failure that reaches the client is expressed as an `AppError` so the
 * global error handler (src/plugins/error-handler.ts) can serialise one
 * consistent envelope:
 *
 *   { "error": { "code": "FORBIDDEN", "message": "...", "details": [...] }, "requestId": "..." }
 *
 * Anything thrown that is *not* an AppError is treated as a bug: it is logged
 * with its stack server-side and reported to the client as a generic 500. Stack
 * traces never cross the network.
 */

export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  TOKEN_REUSED: 'TOKEN_REUSED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  UNPROCESSABLE: 'UNPROCESSABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface FieldIssue {
  path: string;
  message: string;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCodeValue;
  readonly details?: FieldIssue[];
  /** `true` for errors we raised deliberately; the handler will not log a stack for these. */
  readonly expected = true;

  constructor(statusCode: number, code: ErrorCodeValue, message: string, details?: FieldIssue[]) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export const badRequest = (message: string, details?: FieldIssue[]) =>
  new AppError(400, ErrorCode.VALIDATION_ERROR, message, details);

export const unauthenticated = (message = 'Authentication required.', code: ErrorCodeValue = ErrorCode.UNAUTHENTICATED) =>
  new AppError(401, code, message);

/**
 * Deliberately vague: the same message is returned whether the email exists or
 * the password was wrong, so the endpoint cannot be used to enumerate accounts.
 */
export const invalidCredentials = () =>
  new AppError(401, ErrorCode.INVALID_CREDENTIALS, 'Email or password is incorrect.');

export const forbidden = (message = 'You do not have access to this resource.') =>
  new AppError(403, ErrorCode.FORBIDDEN, message);

export const notFound = (resource = 'Resource') => new AppError(404, ErrorCode.NOT_FOUND, `${resource} not found.`);

export const conflict = (message: string) => new AppError(409, ErrorCode.CONFLICT, message);

export const unprocessable = (message: string, details?: FieldIssue[]) =>
  new AppError(422, ErrorCode.UNPROCESSABLE, message, details);

export const internalError = (message = 'An unexpected error occurred.') =>
  new AppError(500, ErrorCode.INTERNAL_ERROR, message);

export const isAppError = (error: unknown): error is AppError =>
  error instanceof AppError || (typeof error === 'object' && error !== null && (error as AppError).expected === true);
