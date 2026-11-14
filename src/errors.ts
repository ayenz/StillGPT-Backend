/**
 * One internal error type; each API surface renders it in its own envelope
 * (native, OpenAI, Anthropic). `code` is a stable machine-readable identifier.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export const badRequest = (message: string, code = 'invalid_request', details?: Record<string, unknown>) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Missing or invalid credentials') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed') => new AppError(403, 'forbidden', message);
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (message: string, code = 'conflict') => new AppError(409, code, message);

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AppError(500, 'internal_error', message);
}

/** `{error:{code,message}}` — our own API (PWA, Flutter, n8n). */
export function nativeErrorBody(err: AppError) {
  return { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } };
}

const OPENAI_TYPES: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  409: 'conflict_error',
  429: 'rate_limit_error',
};

/** OpenAI envelope: `{error:{message,type,param,code}}`. */
export function openaiErrorBody(err: AppError) {
  return {
    error: {
      message: err.message,
      type: OPENAI_TYPES[err.status] ?? (err.status >= 500 ? 'server_error' : 'invalid_request_error'),
      param: (err.details?.param as string | undefined) ?? null,
      code: err.code,
    },
  };
}

const ANTHROPIC_TYPES: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  409: 'invalid_request_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  503: 'overloaded_error',
};

/** Anthropic envelope: `{type:"error", error:{type,message}}`. */
export function anthropicErrorBody(err: AppError) {
  return {
    type: 'error',
    error: { type: ANTHROPIC_TYPES[err.status] ?? (err.status >= 500 ? 'api_error' : 'invalid_request_error'), message: err.message },
  };
}
