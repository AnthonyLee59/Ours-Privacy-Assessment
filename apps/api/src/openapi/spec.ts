import {
  CROP_MODES,
  DEFAULT_CROP,
  ERRORS,
  FORMAT_ALIASES,
  INPUT_FORMATS,
  LIMITS,
  MIME_TYPES,
  OUTPUT_FORMATS,
  PROBLEM_CONTENT_TYPE,
  problemType,
} from '@image-service/contract';
import type { ErrorCode } from '@image-service/contract';
import type { Config } from '../config.js';

/**
 * OpenAPI 3.1 document, generated from the shared contract constants so enums,
 * bounds and error codes cannot drift from what the API enforces (tests check
 * this). Server-side limits come from the running config.
 */
export function buildOpenApiDocument(config: Config): Record<string, unknown> {
  const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

  const header = (description: string, schema: Record<string, unknown> = { type: 'string' }) => ({
    description,
    schema,
  });
  const integer = { type: 'integer' };

  const problem = (codes: ErrorCode[], description: string, headers?: Record<string, unknown>) => ({
    description,
    ...(headers && { headers }),
    content: {
      [PROBLEM_CONTENT_TYPE]: {
        schema: { $ref: '#/components/schemas/ProblemDetails' },
        examples: Object.fromEntries(
          codes.map((code) => [
            code,
            {
              value: {
                type: problemType(code),
                title: ERRORS[code].title,
                status: ERRORS[code].status,
                detail: EXAMPLE_DETAILS[code],
                code,
                instance: '/v1/process',
                requestId: '6f1c2a8e-1b2c-4d5e-8f90-1234567890ab',
                ...(code === 'INVALID_PARAMETER' && {
                  errors: [{ param: 'width', message: 'width must be between 1 and 4000' }],
                }),
              },
            },
          ]),
        ),
      },
    },
  });

  const processParameters = [
    {
      name: 'url',
      in: 'query',
      required: true,
      description:
        'Public http(s) URL of the source image. URL-encode it if it has its own query string. ' +
        `Ports 80/443 only; private, loopback and internal addresses are refused. Max ${LIMITS.maxUrlLength} characters.`,
      schema: { type: 'string', format: 'uri', maxLength: LIMITS.maxUrlLength },
      example: 'https://picsum.photos/id/237/1200/800.jpg',
    },
    {
      name: 'width',
      in: 'query',
      description:
        'Target width in pixels. With only one dimension the other keeps the aspect ratio.',
      schema: { type: 'integer', minimum: 1, maximum: LIMITS.maxDimension },
      example: 500,
    },
    {
      name: 'height',
      in: 'query',
      description: 'Target height in pixels.',
      schema: { type: 'integer', minimum: 1, maximum: LIMITS.maxDimension },
      example: 300,
    },
    {
      name: 'format',
      in: 'query',
      description: `Output format; defaults to the source format (TIFF becomes PNG). \`jpg\` is an alias of \`jpeg\`. Case-insensitive.`,
      schema: { type: 'string', enum: [...OUTPUT_FORMATS, ...Object.keys(FORMAT_ALIASES)] },
    },
    {
      name: 'quality',
      in: 'query',
      description:
        'Lossy encoder quality (jpeg, webp, avif). Ignored when the format is inferred as lossless; ' +
        'a 400 when format=png or format=gif is given explicitly.',
      schema: {
        type: 'integer',
        minimum: LIMITS.minQuality,
        maximum: LIMITS.maxQuality,
        default: LIMITS.defaultQuality,
      },
    },
    {
      name: 'crop',
      in: 'query',
      description:
        'How to fit width x height. fill: crop to exactly the box (centre). fit: inside the box, keeps aspect, may upscale. ' +
        'limit: like fit but never upscales. pad: fit then pad to the exact box (transparent, or white for jpeg). ' +
        'scale: stretch to exactly the box. fill, pad and scale need both width and height.',
      schema: { type: 'string', enum: [...CROP_MODES], default: DEFAULT_CROP },
    },
  ];

  const rateLimitHeaders = {
    RateLimit: header('Remaining quota, IETF draft-8 format, e.g. `"60-in-1min"; r=59; t=60`.'),
    'RateLimit-Policy': header('Quota policy, e.g. `"60-in-1min"; q=60; w=60`.'),
  };

  const processOperation = (alias: boolean) => ({
    operationId: alias ? 'processImageAlias' : 'processImage',
    summary: alias ? 'Alias of /v1/process' : 'Resize and/or convert an image',
    description: alias
      ? 'Identical to `/v1/process`; kept so the original request examples work verbatim. Prefer the versioned path.'
      : 'Fetches the source URL, applies the transformation and returns the encoded image. ' +
        'Results are cached; identical concurrent requests share one fetch. Metadata (EXIF/GPS) is stripped and EXIF orientation applied. ' +
        'Only the first frame of animated images is used.',
    tags: ['Images'],
    parameters: processParameters,
    responses: {
      '200': {
        description: 'The processed image.',
        headers: {
          ETag: header(
            'Strong validator of the output bytes. Send it back as `If-None-Match` to get a 304.',
          ),
          'Cache-Control': header('`public, max-age=86400`.'),
          'Content-Disposition': header(
            '`inline` with a filename derived from the source, e.g. `cat.webp`.',
          ),
          'X-Cache': header('`HIT` if served from the result cache, otherwise `MISS`.', {
            type: 'string',
            enum: ['HIT', 'MISS'],
          }),
          'X-Source-Width': header('Source width in pixels (after EXIF orientation).', integer),
          'X-Source-Height': header('Source height in pixels (after EXIF orientation).', integer),
          'X-Source-Format': header('Detected source format.', {
            type: 'string',
            enum: [...INPUT_FORMATS],
          }),
          'X-Source-Bytes': header('Source file size in bytes.', integer),
          'X-Output-Width': header('Width of the returned image in pixels.', integer),
          'X-Output-Height': header('Height of the returned image in pixels.', integer),
          'X-Request-Id': header('Request id; quote it when reporting problems.'),
          ...rateLimitHeaders,
        },
        content: Object.fromEntries(
          OUTPUT_FORMATS.map((format) => [
            MIME_TYPES[format],
            { schema: { type: 'string', contentMediaType: MIME_TYPES[format] } },
          ]),
        ),
      },
      '304': { description: 'Not modified: `If-None-Match` matched the current ETag.' },
      '400': problem(
        ['INVALID_PARAMETER', 'URL_NOT_ALLOWED'],
        'Invalid parameters (all problems listed in `errors`) or a disallowed source URL.',
      ),
      '405': problem(['METHOD_NOT_ALLOWED'], 'Only GET and HEAD are supported.'),
      '413': problem(['SOURCE_TOO_LARGE'], `Source file larger than ${mb(config.maxSourceBytes)}.`),
      '415': problem(
        ['UNSUPPORTED_MEDIA_TYPE'],
        `Source is not a supported image (${INPUT_FORMATS.join(', ')}), e.g. an HTML page, SVG or PDF.`,
      ),
      '422': problem(
        ['IMAGE_TOO_LARGE', 'PROCESSING_FAILED'],
        `Source over ${config.maxInputPixels / 1e6} MP, or corrupt/truncated.`,
      ),
      '429': problem(['RATE_LIMITED'], 'Per-client rate limit exceeded.', {
        'Retry-After': header('Seconds until the quota resets.', integer),
        ...rateLimitHeaders,
      }),
      '500': problem(['INTERNAL'], 'Unexpected server error; quote `requestId` when reporting.'),
      '502': problem(
        ['SOURCE_FETCH_FAILED', 'TOO_MANY_REDIRECTS'],
        `Source could not be fetched: upstream error status, DNS/connection failure, or more than ${config.maxRedirects} redirects.`,
      ),
      '503': problem(['SERVER_BUSY'], 'Too many images in progress; retry shortly.', {
        'Retry-After': header('Seconds to wait before retrying.', integer),
      }),
      '504': problem(
        ['SOURCE_TIMEOUT'],
        `Source did not respond within ${config.fetchTimeoutMs / 1000}s.`,
      ),
    },
  });

  return {
    openapi: '3.1.0',
    info: {
      title: 'Image Processing API',
      version: '1.0.0',
      description:
        'Cloudinary-style resizing and format conversion for images at public URLs.\n\n' +
        'Errors use RFC 9457 `application/problem+json` with a stable `code` to branch on, ' +
        'a human-readable `detail`, per-parameter `errors`, and a `requestId`.',
    },
    servers: [{ url: '/' }],
    tags: [{ name: 'Images' }, { name: 'Service' }],
    paths: {
      '/v1/process': { get: processOperation(false) },
      '/process': { get: processOperation(true) },
      '/video/thumbnail': {
        get: {
          operationId: 'videoThumbnail',
          summary: 'Video thumbnails (not supported)',
          tags: ['Images'],
          responses: { '501': problem(['NOT_IMPLEMENTED'], 'Video processing is not supported.') },
        },
      },
      '/healthz': {
        get: {
          operationId: 'health',
          summary: 'Liveness check',
          tags: ['Service'],
          responses: {
            '200': {
              description: 'The service is up.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { status: { const: 'ok' } },
                    required: ['status'],
                  },
                },
              },
            },
          },
        },
      },
      '/openapi.json': {
        get: {
          operationId: 'openapi',
          summary: 'This OpenAPI document',
          tags: ['Service'],
          responses: {
            '200': { description: 'OpenAPI 3.1 document.', content: { 'application/json': {} } },
          },
        },
      },
    },
    components: {
      schemas: {
        FieldError: {
          type: 'object',
          properties: {
            param: { type: 'string', description: 'Query parameter at fault.' },
            message: { type: 'string', description: 'What is wrong and how to fix it.' },
          },
          required: ['param', 'message'],
        },
        ProblemDetails: {
          type: 'object',
          description: 'RFC 9457 problem details with extensions.',
          properties: {
            type: { type: 'string', format: 'uri' },
            title: { type: 'string' },
            status: { type: 'integer' },
            detail: { type: 'string' },
            instance: { type: 'string' },
            code: { type: 'string', enum: Object.keys(ERRORS) },
            errors: { type: 'array', items: { $ref: '#/components/schemas/FieldError' } },
            requestId: { type: 'string' },
          },
          required: ['type', 'title', 'status', 'detail', 'code'],
        },
      },
    },
  };
}

const EXAMPLE_DETAILS: Record<ErrorCode, string> = {
  INVALID_PARAMETER: 'width must be between 1 and 4000',
  URL_NOT_ALLOWED:
    '169.254.169.254 is a private, loopback or reserved address and cannot be fetched.',
  NOT_FOUND: 'No route for GET /nope. See /docs for available endpoints.',
  METHOD_NOT_ALLOWED: 'POST is not supported here. Use GET, HEAD.',
  SOURCE_TOO_LARGE:
    'The source file is 20971520 bytes (20.0 MB); the limit is 15728640 bytes (15.0 MB).',
  UNSUPPORTED_MEDIA_TYPE:
    'The source URL returned an HTML or XML document, not an image. Link directly to the image file.',
  IMAGE_TOO_LARGE: 'The source image is 12000x9000 (108.0 MP); the limit is 40 MP.',
  PROCESSING_FAILED:
    'The source image appears to be corrupt or truncated and could not be decoded.',
  RATE_LIMITED: 'Rate limit of 60 requests per minute exceeded. Retry in 42s.',
  INTERNAL: 'Something went wrong on our side. Quote request id 6f1c2a8e-... when reporting this.',
  NOT_IMPLEMENTED: 'Video thumbnails are not supported by this deployment.',
  SOURCE_FETCH_FAILED:
    'The source server responded with HTTP 404. Check that the URL points at a publicly reachable image.',
  TOO_MANY_REDIRECTS: 'The source URL redirected more than 3 times.',
  SERVER_BUSY: 'The server is processing too many images right now. Retry shortly.',
  SOURCE_TIMEOUT: 'The source URL did not finish responding within 10s.',
};
