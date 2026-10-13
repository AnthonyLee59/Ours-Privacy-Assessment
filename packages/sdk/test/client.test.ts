import { parseProcessParams, problemType } from '@image-service/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageApiError, ImageClient } from '../src/index.js';
import type { TransformOptions } from '../src/index.js';

const BASE = 'https://img.example.com';
const SRC = 'https://example.com/cat.png';

function imageResponse(headers: Record<string, string> = {}, body = new Uint8Array([1, 2, 3, 4])) {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'image/webp',
      'Content-Length': String(body.length),
      ETag: '"abc"',
      'X-Cache': 'MISS',
      'X-Request-Id': 'req-1',
      'X-Source-Width': '1200',
      'X-Source-Height': '800',
      'X-Source-Format': 'png',
      'X-Source-Bytes': '54321',
      'X-Output-Width': '600',
      'X-Output-Height': '400',
      ...headers,
    },
  });
}

function problemResponse(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  headers = {},
) {
  return new Response(
    JSON.stringify({
      type: problemType(code as 'INVALID_PARAMETER'),
      title: 'Title',
      status,
      detail: `detail for ${code}`,
      code,
      requestId: 'req-9',
      ...extra,
    }),
    { status, headers: { 'Content-Type': 'application/problem+json', ...headers } },
  );
}

function clientWith(response: Response | (() => Promise<Response>)) {
  const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    typeof response === 'function' ? response() : Promise.resolve(response),
  );
  return { client: new ImageClient({ baseUrl: BASE, fetch }), fetch };
}

async function caught(promise: Promise<unknown>): Promise<ImageApiError> {
  const error = await promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ImageApiError);
  return error as ImageApiError;
}

afterEach(() => vi.restoreAllMocks());

describe('ImageClient#url', () => {
  const client = new ImageClient({ baseUrl: BASE });

  it('builds the PDF resize example', () => {
    expect(client.url({ url: 'https://example.com/image.jpg', width: 500, height: 300 })).toBe(
      `${BASE}/v1/process?url=https%3A%2F%2Fexample.com%2Fimage.jpg&width=500&height=300`,
    );
  });

  it('builds the PDF combined example with parameters in canonical order', () => {
    const url = client.url({
      crop: 'fill',
      format: 'webp',
      height: 600,
      width: 800,
      url: 'https://example.com/image.jpg',
    });
    expect(url).toBe(
      `${BASE}/v1/process?url=https%3A%2F%2Fexample.com%2Fimage.jpg&width=800&height=600&format=webp&crop=fill`,
    );
  });

  it('encodes source URLs that carry their own query string', () => {
    const url = client.url({ url: 'https://cdn.test/a.png?size=large&v=2', width: 10 });
    expect(new URL(url).searchParams.get('url')).toBe('https://cdn.test/a.png?size=large&v=2');
    expect(new URL(url).searchParams.get('width')).toBe('10');
  });

  it('omits options that are undefined', () => {
    expect(client.url({ url: SRC, width: undefined, format: 'png' })).toBe(
      `${BASE}/v1/process?url=${encodeURIComponent(SRC)}&format=png`,
    );
  });

  it('produces URLs the server-side validator accepts unchanged', () => {
    const options: TransformOptions = {
      url: SRC,
      width: 300,
      height: 200,
      format: 'avif',
      quality: 55,
      crop: 'pad',
    };
    const parsed = parseProcessParams(new URL(client.url(options)).searchParams);
    expect(parsed).toEqual({ ok: true, value: options });
  });

  it.each([
    ['https://img.example.com/', `https://img.example.com/v1/process`],
    ['https://img.example.com/base/', `https://img.example.com/base/v1/process`],
    ['', '/v1/process'],
  ])('joins base %j cleanly', (baseUrl, prefix) => {
    expect(new ImageClient({ baseUrl }).url({ url: SRC })).toBe(
      `${prefix}?url=${encodeURIComponent(SRC)}`,
    );
  });

  it('defaults to a same-origin relative base', () => {
    expect(new ImageClient().url({ url: SRC })).toMatch(/^\/v1\/process\?/);
  });

  it.each(['not a url', 'ftp://img.example.com', 'https://img.example.com/?x=1'])(
    'rejects base URL %j',
    (baseUrl) => {
      expect(() => new ImageClient({ baseUrl })).toThrow(TypeError);
    },
  );

  it('validates with the same rules and messages as the server, listing every problem', () => {
    try {
      client.url({ url: SRC, width: 0, crop: 'fill' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ImageApiError);
      const e = error as ImageApiError;
      expect(e.code).toBe('INVALID_PARAMETER');
      expect(e.status).toBeUndefined();
      expect(e.errors.map((f) => f.param)).toEqual(['width', 'crop']);
      expect(e.message).toMatch(/2 parameters are invalid/);
    }
  });

  it('rejects cross-field mistakes such as quality with png', () => {
    expect(() => client.url({ url: SRC, format: 'png', quality: 80 })).toThrow(
      /quality only applies/,
    );
  });

  it('rejects non-primitive values from untyped callers by name', () => {
    const options = { url: SRC, width: { px: 10 } } as unknown as TransformOptions;
    expect(() => client.url(options)).toThrow(/width must be a whole number/);
  });

  it('catches typos from untyped JavaScript callers', () => {
    const options = { url: SRC, widht: 10 } as unknown as TransformOptions;
    expect(() => client.url(options)).toThrow(/Did you mean "width"/);
  });
});

describe('ImageClient#process — success', () => {
  it('returns the image with output and source details parsed from headers', async () => {
    const { client } = clientWith(imageResponse());
    const result = await client.process({ url: SRC, width: 600, format: 'webp' });

    expect(result).toMatchObject({
      url: client.url({ url: SRC, width: 600, format: 'webp' }),
      contentType: 'image/webp',
      format: 'webp',
      bytes: 4,
      width: 600,
      height: 400,
      etag: '"abc"',
      cache: 'MISS',
      requestId: 'req-1',
      source: { width: 1200, height: 800, format: 'png', bytes: 54321 },
    });
    expect(result.blob.size).toBe(4);
  });

  it('asks for an image (or a problem) and forwards the abort signal', async () => {
    const { client, fetch } = clientWith(imageResponse());
    const controller = new AbortController();
    await client.process({ url: SRC }, { signal: controller.signal });
    const init = fetch.mock.calls[0]![1]!;
    expect(init.signal).toBe(controller.signal);
    expect(new Headers(init.headers).get('accept')).toBe('image/*, application/problem+json');
  });

  it('reports a cache HIT', async () => {
    const { client } = clientWith(imageResponse({ 'X-Cache': 'HIT' }));
    expect((await client.process({ url: SRC })).cache).toBe('HIT');
  });

  it('calls the global fetch with the right receiver by default (no "Illegal invocation")', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(function (this: unknown) {
      expect(this === undefined || this === globalThis).toBe(true);
      return Promise.resolve(imageResponse());
    });
    await new ImageClient({ baseUrl: BASE }).process({ url: SRC });
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe('ImageClient#process — errors', () => {
  it('validates before making any request', async () => {
    const { client, fetch } = clientWith(imageResponse());
    await caught(client.process({ url: 'ftp://example.com/a.png' }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('turns problem+json responses into ImageApiError with all details', async () => {
    const { client } = clientWith(
      problemResponse(400, 'URL_NOT_ALLOWED', { errors: [{ param: 'url', message: 'nope' }] }),
    );
    const error = await caught(client.process({ url: SRC }));
    expect(error).toMatchObject({
      name: 'ImageApiError',
      status: 400,
      code: 'URL_NOT_ALLOWED',
      message: 'detail for URL_NOT_ALLOWED',
      errors: [{ param: 'url', message: 'nope' }],
      requestId: 'req-9',
      isRetryable: false,
    });
    expect(error.problem?.code).toBe('URL_NOT_ALLOWED');
  });

  it.each([
    [429, 'RATE_LIMITED'],
    [503, 'SERVER_BUSY'],
    [504, 'SOURCE_TIMEOUT'],
  ])('marks %i %s as retryable and parses Retry-After', async (status, code) => {
    const { client } = clientWith(problemResponse(status, code, {}, { 'Retry-After': '42' }));
    const error = await caught(client.process({ url: SRC }));
    expect(error.isRetryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(42);
  });

  it('parses Retry-After given as an HTTP date', async () => {
    const at = new Date(Date.now() + 30_000).toUTCString();
    const { client } = clientWith(problemResponse(503, 'SERVER_BUSY', {}, { 'Retry-After': at }));
    const seconds = (await caught(client.process({ url: SRC }))).retryAfterSeconds!;
    expect(seconds).toBeGreaterThanOrEqual(28);
    expect(seconds).toBeLessThanOrEqual(31);
  });

  it('ignores an unparseable Retry-After', async () => {
    const { client } = clientWith(
      problemResponse(503, 'SERVER_BUSY', {}, { 'Retry-After': 'soon' }),
    );
    expect((await caught(client.process({ url: SRC }))).retryAfterSeconds).toBeUndefined();
  });

  it.each([
    [400, 'INVALID_PARAMETER'],
    [415, 'UNSUPPORTED_MEDIA_TYPE'],
    [422, 'IMAGE_TOO_LARGE'],
    [502, 'SOURCE_FETCH_FAILED'],
  ])('marks %i %s as not retryable', async (status, code) => {
    const { client } = clientWith(problemResponse(status, code));
    expect((await caught(client.process({ url: SRC }))).isRetryable).toBe(false);
  });

  it('handles error bodies that are not problem+json (e.g. a proxy page)', async () => {
    const { client } = clientWith(
      new Response('<html>Bad gateway</html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    const error = await caught(client.process({ url: SRC }));
    expect(error).toMatchObject({ code: 'UNEXPECTED_RESPONSE', status: 502, isRetryable: true });
    expect(error.message).toMatch(/HTTP 502/);
  });

  it('handles malformed JSON error bodies', async () => {
    const { client } = clientWith(
      new Response('{"truncated', { status: 500, headers: { 'Content-Type': 'application/json' } }),
    );
    expect(await caught(client.process({ url: SRC }))).toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
      status: 500,
    });
  });

  it('handles a success status with a non-image body', async () => {
    const { client } = clientWith(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    expect(await caught(client.process({ url: SRC }))).toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
      status: 200,
    });
  });

  it('wraps network failures, keeping the cause', async () => {
    const failure = new TypeError('fetch failed');
    const { client } = clientWith(() => Promise.reject(failure));
    const error = await caught(client.process({ url: SRC }));
    expect(error).toMatchObject({ code: 'NETWORK_ERROR', status: undefined, isRetryable: true });
    expect(error.cause).toBe(failure);
    expect(error.message).toMatch(/img\.example\.com/);
  });

  it('lets aborts through untouched so callers can ignore them', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    const { client } = clientWith(() => Promise.reject(abort));
    await expect(client.process({ url: SRC })).rejects.toBe(abort);
  });
});

describe('ImageApiError.is', () => {
  it('recognises errors across duplicate package copies by shape', () => {
    const lookalike = Object.assign(new Error('x'), {
      name: 'ImageApiError',
      code: 'RATE_LIMITED',
      errors: [],
    });
    expect(ImageApiError.is(lookalike)).toBe(true);
    expect(ImageApiError.is(new Error('x'))).toBe(false);
    expect(ImageApiError.is('nope')).toBe(false);
  });
});
