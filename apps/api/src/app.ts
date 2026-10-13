import cors from 'cors';
import express from 'express';
import type { Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { createResultCache } from './cache/memory-cache.js';
import type { Config } from './config.js';
import { createFetcher } from './fetch/fetcher.js';
import type { Fetcher } from './fetch/fetcher.js';
import { ApiError } from './http/api-error.js';
import { createErrorHandler, methodNotAllowed, notFoundHandler } from './http/error-handler.js';
import { createRateLimiter } from './http/rate-limit.js';
import { REQUEST_ID_HEADER, assignRequestId } from './http/request-id.js';
import { docsRouter } from './openapi/docs.js';
import { buildOpenApiDocument } from './openapi/spec.js';
import { createLimiter } from './process/limiter.js';
import { createProcessService } from './process/service.js';
import { PROCESS_PATHS, processRouter } from './routes/process.js';
import type { UrlPolicy } from './security/url-policy.js';
import { staticUi } from './static.js';

export interface AppDependencies {
  config: Config;
  logger: Logger;
  /** Defaults to one built from config; pass one in to own its lifecycle (close on shutdown). */
  fetcher?: Fetcher;
  /** Defaults to config.allowedHosts with ports 80/443. */
  urlPolicy?: UrlPolicy;
}

/** Fetcher with the SSRF-safe DNS lookup and limits from config. */
export function createFetcherFromConfig(config: Config): Fetcher {
  return createFetcher({
    urlPolicy: { allowedHosts: config.allowedHosts },
    maxBytes: config.maxSourceBytes,
    maxRedirects: config.maxRedirects,
    connectTimeoutMs: Math.min(3_000, config.fetchTimeoutMs),
    headersTimeoutMs: Math.min(5_000, config.fetchTimeoutMs),
    totalTimeoutMs: config.fetchTimeoutMs,
  });
}

/** Response headers browsers may read cross-origin (the UI and third-party clients rely on these). */
const EXPOSED_HEADERS = [
  REQUEST_ID_HEADER,
  'X-Cache',
  'X-Source-Width',
  'X-Source-Height',
  'X-Source-Format',
  'X-Source-Bytes',
  'X-Output-Width',
  'X-Output-Height',
  'ETag',
  'Content-Length',
  'Content-Disposition',
  'RateLimit',
  'RateLimit-Policy',
  'Retry-After',
];

const READ_ONLY = ['GET', 'HEAD'];

export function createApp({
  config,
  logger,
  fetcher = createFetcherFromConfig(config),
  urlPolicy = { allowedHosts: config.allowedHosts },
}: AppDependencies): Express {
  const processService = createProcessService({
    fetcher,
    urlPolicy,
    cache: createResultCache({
      maxBytes: config.cacheMaxBytes,
      ttlMs: config.cacheTtlSeconds * 1000,
    }),
    limiter: createLimiter({
      concurrency: config.processingConcurrency,
      maxQueue: config.processingQueueSize,
    }),
    imageLimits: {
      maxInputPixels: config.maxInputPixels,
      timeoutSeconds: config.processingTimeoutSeconds,
    },
  });

  const app = express();
  app.disable('x-powered-by');
  // Decides what req.ip is (and so the rate-limit key) when behind a load balancer.
  app.set('trust proxy', config.trustProxy);

  app.use(
    pinoHttp({
      logger,
      genReqId: assignRequestId,
      // Only genuine faults page someone; deliberate 4xx/5xx answers (501, 502, 503...) are warnings.
      customLogLevel: (_req, res) => {
        if (res.statusCode === 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );
  app.use(
    helmet({
      // Processed images are meant to be embedded by other sites.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: {
        directives: {
          // helmet's default allows inline styles and any https: stylesheet; we need neither.
          'style-src': ["'self'"],
          // Would break http:// source previews and plain-http local runs; HSTS covers https.
          'upgrade-insecure-requests': null,
        },
      },
    }),
  );
  app.use(
    cors({ origin: '*', methods: READ_ONLY, exposedHeaders: EXPOSED_HEADERS, maxAge: 86400 }),
  );

  app
    .route('/healthz')
    .get((_req, res) => {
      res.set('Cache-Control', 'no-store').json({ status: 'ok' });
    })
    .all(methodNotAllowed(READ_ONLY));

  app.use(docsRouter(buildOpenApiDocument(config)));

  // After CORS so browsers can read 429 bodies; only image work is limited, not health checks.
  app.use(PROCESS_PATHS, createRateLimiter(config.rateLimitPerMinute));
  app.use(processRouter(processService));

  app
    .route('/video/thumbnail')
    .get(() => {
      throw new ApiError(
        'NOT_IMPLEMENTED',
        'Video thumbnails are not supported by this deployment. Only images can be processed via /v1/process.',
      );
    })
    .all(methodNotAllowed(READ_ONLY));

  // Last before 404: the UI must never shadow an API route.
  if (config.staticDir) app.use(staticUi(config.staticDir));

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}
