import type { LookupFunction } from 'node:net';
import { Agent, request } from 'undici';
import type { Dispatcher } from 'undici';
import { ApiError } from '../http/api-error.js';
import { createPinnedLookup } from '../security/pinned-lookup.js';
import { assertAllowedSourceUrl } from '../security/url-policy.js';
import type { UrlPolicy } from '../security/url-policy.js';

export interface FetcherOptions {
  urlPolicy: UrlPolicy;
  /** DNS lookup used for every connection. Defaults to the SSRF-safe pinned lookup. */
  lookup?: LookupFunction;
  maxBytes: number;
  maxRedirects: number;
  connectTimeoutMs: number;
  headersTimeoutMs: number;
  /** Deadline for the whole fetch, across all redirects and the body download. */
  totalTimeoutMs: number;
}

export interface FetchedSource {
  bytes: Buffer;
  finalUrl: URL;
}

export interface Fetcher {
  fetch(url: string | URL, signal?: AbortSignal): Promise<FetchedSource>;
  close(): Promise<void>;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const REQUEST_HEADERS = {
  'user-agent': 'image-service/0.1',
  accept: 'image/avif,image/webp,image/*;q=0.9',
  // Compressed bodies would need inflating, which is a decompression-bomb risk for no gain on images.
  'accept-encoding': 'identity',
};

const TIMEOUT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT',
]);
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL']);

function fetchFailed(detail: string): ApiError {
  return new ApiError('SOURCE_FETCH_FAILED', detail);
}

function formatBytes(bytes: number): string {
  return `${bytes} bytes (${(bytes / 1024 / 1024).toFixed(1)} MB)`;
}

/** Error codes along the `cause` chain; undici and net wrap the interesting one. */
function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  for (let e = error; e instanceof Error; e = e.cause) {
    const { code } = e as { code?: unknown };
    if (typeof code === 'string') codes.push(code);
  }
  return codes;
}

/**
 * Abandon a response body. undici emits an 'error' (RequestAbortedError) when a
 * body is destroyed; without a listener that becomes an uncaught exception.
 */
function abandon(body: Dispatcher.ResponseData['body']): void {
  body.on('error', () => {});
  body.destroy();
}

function header(headers: Dispatcher.ResponseData['headers'], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function createFetcher(options: FetcherOptions): Fetcher {
  const agent = new Agent({
    connect: {
      lookup: options.lookup ?? createPinnedLookup(),
      timeout: options.connectTimeoutMs,
    },
    headersTimeout: options.headersTimeoutMs,
    bodyTimeout: options.totalTimeoutMs,
  });

  const tooLarge = (size?: number) =>
    new ApiError(
      'SOURCE_TOO_LARGE',
      size === undefined
        ? `The source file is larger than the limit of ${formatBytes(options.maxBytes)}.`
        : `The source file is ${formatBytes(size)}; the limit is ${formatBytes(options.maxBytes)}.`,
    );

  /** Translate network-level failures into caller-facing API errors. */
  function translate(
    error: unknown,
    url: URL,
    deadline: AbortSignal,
    caller?: AbortSignal,
  ): unknown {
    if (error instanceof ApiError) return error;
    // The client went away: not an API error, just stop.
    if (caller?.aborted) return caller.reason;
    if (deadline.aborted) {
      return new ApiError(
        'SOURCE_TIMEOUT',
        `The source URL did not finish responding within ${options.totalTimeoutMs / 1000}s.`,
      );
    }
    const codes = errorCodes(error);
    if (codes.includes('ERR_BLOCKED_ADDRESS')) {
      // Do not echo the resolved address: it would leak internal network details.
      return new ApiError(
        'URL_NOT_ALLOWED',
        `${url.hostname} resolves to a private, loopback or reserved address and cannot be fetched.`,
      );
    }
    if (codes.some((code) => TIMEOUT_CODES.has(code))) {
      return new ApiError('SOURCE_TIMEOUT', `${url.host} took too long to respond.`);
    }
    if (codes.some((code) => DNS_CODES.has(code))) {
      return fetchFailed(`Could not resolve host ${url.hostname}. Check the URL for typos.`);
    }
    return fetchFailed(`Could not connect to ${url.host} (${codes[0] ?? 'network error'}).`);
  }

  async function readBody(response: Dispatcher.ResponseData): Promise<Buffer> {
    const declared = Number(header(response.headers, 'content-length'));
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      abandon(response.body);
      throw tooLarge(declared);
    }
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of response.body as AsyncIterable<Buffer>) {
      received += chunk.length;
      if (received > options.maxBytes) {
        abandon(response.body);
        throw tooLarge();
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function fetchOnce(
    url: URL,
    signal: AbortSignal,
  ): Promise<{ redirect: URL } | { bytes: Buffer }> {
    const response = await request(url, {
      method: 'GET',
      dispatcher: agent,
      headers: REQUEST_HEADERS,
      signal,
    });
    const status = response.statusCode;

    if (REDIRECT_STATUSES.has(status)) {
      await response.body.dump();
      const location = header(response.headers, 'location');
      if (!location) {
        throw fetchFailed(
          `${url.host} sent a redirect (HTTP ${status}) without a Location header.`,
        );
      }
      return { redirect: new URL(location, url) };
    }
    if (status === 429) {
      await response.body.dump();
      throw fetchFailed(
        `The source server is rate-limiting this service (HTTP 429). Try again later or use a different image host.`,
      );
    }
    if (status !== 200) {
      await response.body.dump();
      throw fetchFailed(
        `The source server responded with HTTP ${status}. Check that the URL points at a publicly reachable image.`,
      );
    }
    const encoding = header(response.headers, 'content-encoding');
    if (encoding && encoding !== 'identity') {
      abandon(response.body);
      throw fetchFailed(
        `The source server sent a compressed (${encoding}) response, which is not supported.`,
      );
    }
    return { bytes: await readBody(response) };
  }

  return {
    async fetch(input, caller) {
      const deadline = AbortSignal.timeout(options.totalTimeoutMs);
      const signal = caller ? AbortSignal.any([deadline, caller]) : deadline;
      let next: string | URL = input;

      for (let hop = 0; hop <= options.maxRedirects; hop++) {
        const url = assertAllowedSourceUrl(next, options.urlPolicy);
        let outcome;
        try {
          outcome = await fetchOnce(url, signal);
        } catch (error) {
          throw translate(error, url, deadline, caller);
        }
        if ('bytes' in outcome) return { bytes: outcome.bytes, finalUrl: url };
        next = outcome.redirect;
      }
      throw new ApiError(
        'TOO_MANY_REDIRECTS',
        `The source URL redirected more than ${options.maxRedirects} times.`,
      );
    },
    close: () => agent.close(),
  };
}
