import { describe, expect, it } from 'vitest';
import { ERRORS, isProblemDetails, problemType } from '../src/index.js';
import type { ErrorCode } from '../src/index.js';

describe('ERRORS catalogue', () => {
  const entries = Object.entries(ERRORS) as [ErrorCode, (typeof ERRORS)[ErrorCode]][];

  it.each(entries)('%s has an HTTP error status and a title', (_code, { status, title }) => {
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(600);
    expect(title.length).toBeGreaterThan(0);
  });

  it('maps the codes the API contract promises to the agreed statuses', () => {
    expect({
      INVALID_PARAMETER: ERRORS.INVALID_PARAMETER.status,
      URL_NOT_ALLOWED: ERRORS.URL_NOT_ALLOWED.status,
      SOURCE_FETCH_FAILED: ERRORS.SOURCE_FETCH_FAILED.status,
      SOURCE_TIMEOUT: ERRORS.SOURCE_TIMEOUT.status,
      SOURCE_TOO_LARGE: ERRORS.SOURCE_TOO_LARGE.status,
      TOO_MANY_REDIRECTS: ERRORS.TOO_MANY_REDIRECTS.status,
      UNSUPPORTED_MEDIA_TYPE: ERRORS.UNSUPPORTED_MEDIA_TYPE.status,
      IMAGE_TOO_LARGE: ERRORS.IMAGE_TOO_LARGE.status,
      PROCESSING_FAILED: ERRORS.PROCESSING_FAILED.status,
      RATE_LIMITED: ERRORS.RATE_LIMITED.status,
      SERVER_BUSY: ERRORS.SERVER_BUSY.status,
      NOT_FOUND: ERRORS.NOT_FOUND.status,
      METHOD_NOT_ALLOWED: ERRORS.METHOD_NOT_ALLOWED.status,
      NOT_IMPLEMENTED: ERRORS.NOT_IMPLEMENTED.status,
      INTERNAL: ERRORS.INTERNAL.status,
    }).toEqual({
      INVALID_PARAMETER: 400,
      URL_NOT_ALLOWED: 400,
      SOURCE_FETCH_FAILED: 502,
      SOURCE_TIMEOUT: 504,
      SOURCE_TOO_LARGE: 413,
      TOO_MANY_REDIRECTS: 502,
      UNSUPPORTED_MEDIA_TYPE: 415,
      IMAGE_TOO_LARGE: 422,
      PROCESSING_FAILED: 422,
      RATE_LIMITED: 429,
      SERVER_BUSY: 503,
      NOT_FOUND: 404,
      METHOD_NOT_ALLOWED: 405,
      NOT_IMPLEMENTED: 501,
      INTERNAL: 500,
    });
  });
});

describe('problemType', () => {
  it('builds a stable URN from the code', () => {
    expect(problemType('INVALID_PARAMETER')).toBe('urn:image-service:problem:invalid-parameter');
  });
});

describe('isProblemDetails', () => {
  const valid = {
    type: problemType('INVALID_PARAMETER'),
    title: 'Invalid parameter',
    status: 400,
    detail: 'width must be a whole number',
    code: 'INVALID_PARAMETER',
  };

  it('accepts a minimal problem body', () => {
    expect(isProblemDetails(valid)).toBe(true);
  });

  it('accepts optional errors and requestId', () => {
    expect(
      isProblemDetails({
        ...valid,
        errors: [{ param: 'width', message: 'bad' }],
        requestId: 'abc',
      }),
    ).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'oops'],
    ['missing code', { ...valid, code: undefined }],
    ['unknown code', { ...valid, code: 'TEAPOT' }],
    ['non-numeric status', { ...valid, status: '400' }],
    ['malformed errors', { ...valid, errors: [{ param: 1 }] }],
    ['non-object errors entry', { ...valid, errors: ['bad'] }],
    ['errors not an array', { ...valid, errors: 'bad' }],
  ])('rejects %s', (_label, body) => {
    expect(isProblemDetails(body)).toBe(false);
  });
});
