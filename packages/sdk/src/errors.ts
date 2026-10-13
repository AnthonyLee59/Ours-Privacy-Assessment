import type { ErrorCode, FieldError, ProblemDetails } from '@image-service/contract';

/** Server error codes plus the two failures that never reach the server's error handler. */
export type ImageApiErrorCode = ErrorCode | 'NETWORK_ERROR' | 'UNEXPECTED_RESPONSE';

export interface ImageApiErrorInit {
  code: ImageApiErrorCode;
  message: string;
  status?: number;
  errors?: FieldError[];
  requestId?: string;
  retryAfterSeconds?: number;
  problem?: ProblemDetails;
  cause?: unknown;
}

/** Statuses where trying again later can succeed. */
const RETRYABLE_STATUSES = new Set([429, 503, 504]);

/**
 * Every failure the SDK reports: local validation (`status` undefined, same
 * messages as the server), problem+json responses, unexpected responses and
 * network errors. Branch on `code`; show `message`; use `errors` for per-field UI.
 */
export class ImageApiError extends Error {
  override readonly name = 'ImageApiError';
  readonly code: ImageApiErrorCode;
  /** HTTP status, or undefined if no response was received (validation, network). */
  readonly status: number | undefined;
  readonly errors: FieldError[];
  readonly requestId: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  /** The raw problem+json body, when the server sent one. */
  readonly problem: ProblemDetails | undefined;
  /** Whether retrying the same request later can reasonably succeed. */
  readonly isRetryable: boolean;

  constructor(init: ImageApiErrorInit) {
    super(init.message, { cause: init.cause });
    this.code = init.code;
    this.status = init.status;
    this.errors = init.errors ?? [];
    this.requestId = init.requestId;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.problem = init.problem;
    this.isRetryable =
      init.code === 'NETWORK_ERROR' ||
      (init.status !== undefined && RETRYABLE_STATUSES.has(init.status)) ||
      (init.code === 'UNEXPECTED_RESPONSE' && init.status !== undefined && init.status >= 500);
  }

  /** Shape check that also works when two copies of the SDK are bundled (where instanceof fails). */
  static is(value: unknown): value is ImageApiError {
    if (!(value instanceof Error) || value.name !== 'ImageApiError') return false;
    const { code, errors } = value as { code?: unknown; errors?: unknown };
    return typeof code === 'string' && Array.isArray(errors);
  }
}
