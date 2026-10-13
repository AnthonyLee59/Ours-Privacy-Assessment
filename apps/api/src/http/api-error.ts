import type { ErrorCode, FieldError } from '@image-service/contract';

export interface ApiErrorOptions {
  errors?: FieldError[];
  /** Extra response headers, e.g. Retry-After or Allow. */
  headers?: Record<string, string>;
  cause?: unknown;
}

/** An error that is safe to show to API callers. Anything else becomes a generic 500. */
export class ApiError extends Error {
  readonly errors: FieldError[] | undefined;
  readonly headers: Record<string, string>;

  constructor(
    readonly code: ErrorCode,
    readonly detail: string,
    options: ApiErrorOptions = {},
  ) {
    super(detail, { cause: options.cause });
    this.name = 'ApiError';
    this.errors = options.errors;
    this.headers = options.headers ?? {};
  }
}
