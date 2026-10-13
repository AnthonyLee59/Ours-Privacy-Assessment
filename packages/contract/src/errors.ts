/**
 * Every error the API can return. `code` is the stable, machine-readable
 * identifier clients should branch on; `title` is a short human summary.
 */
export const ERRORS = {
  INVALID_PARAMETER: { status: 400, title: 'Invalid request parameter' },
  URL_NOT_ALLOWED: { status: 400, title: 'Source URL not allowed' },
  NOT_FOUND: { status: 404, title: 'Route not found' },
  METHOD_NOT_ALLOWED: { status: 405, title: 'Method not allowed' },
  SOURCE_TOO_LARGE: { status: 413, title: 'Source file too large' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, title: 'Unsupported source file type' },
  IMAGE_TOO_LARGE: { status: 422, title: 'Source image dimensions too large' },
  PROCESSING_FAILED: { status: 422, title: 'Image could not be processed' },
  RATE_LIMITED: { status: 429, title: 'Too many requests' },
  INTERNAL: { status: 500, title: 'Internal server error' },
  NOT_IMPLEMENTED: { status: 501, title: 'Not implemented' },
  SOURCE_FETCH_FAILED: { status: 502, title: 'Could not fetch source URL' },
  TOO_MANY_REDIRECTS: { status: 502, title: 'Source URL redirected too many times' },
  SERVER_BUSY: { status: 503, title: 'Server busy' },
  SOURCE_TIMEOUT: { status: 504, title: 'Source URL timed out' },
} as const satisfies Record<string, { status: number; title: string }>;

export type ErrorCode = keyof typeof ERRORS;

export interface FieldError {
  param: string;
  message: string;
}

/** RFC 9457 problem details body, plus `code`, `errors` and `requestId` extensions. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: ErrorCode;
  instance?: string;
  errors?: FieldError[];
  requestId?: string;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export function problemType(code: ErrorCode): string {
  return `urn:image-service:problem:${code.toLowerCase().replaceAll('_', '-')}`;
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERRORS, value);
}

function isFieldError(value: unknown): value is FieldError {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.param === 'string' && typeof v.message === 'string';
}

export function isProblemDetails(value: unknown): value is ProblemDetails {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.type === 'string' &&
    typeof v.title === 'string' &&
    typeof v.status === 'number' &&
    typeof v.detail === 'string' &&
    isErrorCode(v.code) &&
    (v.errors === undefined || (Array.isArray(v.errors) && v.errors.every(isFieldError)))
  );
}
