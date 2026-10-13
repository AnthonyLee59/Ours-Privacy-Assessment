import {
  MIME_TYPES,
  OUTPUT_FORMATS,
  PARAM_NAMES,
  isProblemDetails,
  parseProcessParams,
} from '@image-service/contract';
import type { CropMode, FieldError, InputFormat, OutputFormat } from '@image-service/contract';
import { ImageApiError } from './errors.js';

export interface TransformOptions {
  /** Public http(s) URL of the source image. */
  url: string;
  width?: number;
  height?: number;
  /** Output format; defaults to the source format. `jpg` is accepted as an alias. */
  format?: OutputFormat | 'jpg';
  /** 1-100, lossy formats only. */
  quality?: number;
  /** How to fit width x height; defaults to `fit` on the server. */
  crop?: CropMode;
}

export interface ImageClientOptions {
  /**
   * Where the API lives, e.g. `https://img.example.com` or `/api`.
   * Defaults to `''` (same origin as the page).
   */
  baseUrl?: string;
  /** Custom fetch (tests, retries, instrumentation). Defaults to the global fetch. */
  fetch?: typeof fetch;
}

export interface ProcessResult {
  /** The exact request URL that was fetched. */
  url: string;
  blob: Blob;
  contentType: string;
  format: OutputFormat;
  bytes: number;
  width: number | undefined;
  height: number | undefined;
  etag: string | undefined;
  cache: 'HIT' | 'MISS' | undefined;
  requestId: string | undefined;
  source:
    | {
        width: number | undefined;
        height: number | undefined;
        format: InputFormat;
        bytes: number | undefined;
      }
    | undefined;
}

const PROCESS_PATH = '/v1/process';
const ACCEPT = 'image/*, application/problem+json';

function normaliseBaseUrl(baseUrl: string): string {
  if (baseUrl === '' || baseUrl.startsWith('/')) return baseUrl.replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError(`baseUrl must be an absolute http(s) URL or a path, got "${baseUrl}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`baseUrl must use http or https, got "${parsed.protocol}"`);
  }
  if (parsed.search || parsed.hash) {
    throw new TypeError('baseUrl must not contain a query string or fragment');
  }
  return parsed.href.replace(/\/+$/, '');
}

function validationError(errors: FieldError[]): ImageApiError {
  const message =
    errors.length === 1
      ? errors[0]!.message
      : `${errors.length} parameters are invalid: ${errors.map((e) => e.param).join(', ')}.`;
  return new ImageApiError({ code: 'INVALID_PARAMETER', message, errors });
}

function intHeader(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

/** Retry-After is either delay-seconds or an HTTP date. */
function retryAfterSeconds(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError';
}

async function errorFromResponse(response: Response): Promise<ImageApiError> {
  const common = {
    status: response.status,
    requestId: response.headers.get('x-request-id') ?? undefined,
    retryAfterSeconds: retryAfterSeconds(response.headers),
  };
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('json')) {
    const body: unknown = await response.json().catch(() => undefined);
    if (isProblemDetails(body)) {
      return new ImageApiError({
        ...common,
        code: body.code,
        message: body.detail,
        errors: body.errors ?? [],
        requestId: body.requestId ?? common.requestId,
        problem: body,
      });
    }
  }
  return new ImageApiError({
    ...common,
    code: 'UNEXPECTED_RESPONSE',
    message: `The API responded with HTTP ${response.status} and a body that is not an error document (${contentType || 'no content type'}).`,
  });
}

/**
 * Typed client for the image processing API.
 *
 * @example
 * const images = new ImageClient({ baseUrl: 'https://img.example.com' });
 * const src = images.url({ url: 'https://example.com/cat.jpg', width: 400, format: 'webp' });
 * const { blob, width, height } = await images.process({ url: 'https://example.com/cat.jpg', width: 400 });
 */
export class ImageClient {
  readonly baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: ImageClientOptions = {}) {
    this.baseUrl = normaliseBaseUrl(options.baseUrl ?? '');
    // Wrap the global so it is never called as a method of this object ("Illegal invocation" in browsers).
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /**
   * Build a validated transformation URL, e.g. for an `<img src>`. Throws
   * ImageApiError (code INVALID_PARAMETER) listing every problem, using the
   * same rules and messages as the server.
   */
  url(options: TransformOptions): string {
    const query = new URLSearchParams();
    const entries = Object.entries(options as unknown as Record<string, unknown>);
    // Canonical parameter order, then anything unknown so the validator can name it.
    const known = PARAM_NAMES.flatMap((name) => entries.filter(([key]) => key === name));
    const unknown = entries.filter(([key]) => !(PARAM_NAMES as readonly string[]).includes(key));
    for (const [key, value] of [...known, ...unknown]) {
      if (value === undefined || value === null) continue;
      // Objects/arrays from untyped callers are serialised so the validator can reject them by name.
      const text =
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value);
      query.append(key, text);
    }
    const parsed = parseProcessParams(query);
    if (!parsed.ok) throw validationError(parsed.errors);
    return `${this.baseUrl}${PROCESS_PATH}?${query.toString()}`;
  }

  /** Fetch a processed image. Rejects with ImageApiError; aborts reject with the AbortError as-is. */
  async process(
    options: TransformOptions,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<ProcessResult> {
    const url = this.url(options);

    let response: Response;
    try {
      response = await this.#fetch(url, { headers: { Accept: ACCEPT }, ...(signal && { signal }) });
    } catch (error) {
      if (isAbortError(error)) throw error;
      const target =
        this.baseUrl === '' || this.baseUrl.startsWith('/') ? 'this origin' : this.baseUrl;
      throw new ImageApiError({
        code: 'NETWORK_ERROR',
        message: `Could not reach the image API at ${target}: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    }

    if (!response.ok) throw await errorFromResponse(response);

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
    const format = OUTPUT_FORMATS.find((f) => MIME_TYPES[f] === contentType);
    if (!format) {
      throw new ImageApiError({
        code: 'UNEXPECTED_RESPONSE',
        status: response.status,
        message: `Expected an image but got "${contentType || 'no content type'}".`,
      });
    }

    const blob = await response.blob();
    const { headers } = response;
    const sourceFormat = headers.get('x-source-format') as InputFormat | null;
    const cache = headers.get('x-cache');
    return {
      url,
      blob,
      contentType,
      format,
      bytes: blob.size,
      width: intHeader(headers, 'x-output-width'),
      height: intHeader(headers, 'x-output-height'),
      etag: headers.get('etag') ?? undefined,
      cache: cache === 'HIT' || cache === 'MISS' ? cache : undefined,
      requestId: headers.get('x-request-id') ?? undefined,
      source: sourceFormat
        ? {
            format: sourceFormat,
            width: intHeader(headers, 'x-source-width'),
            height: intHeader(headers, 'x-source-height'),
            bytes: intHeader(headers, 'x-source-bytes'),
          }
        : undefined,
    };
  }
}
