import type { Request, RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { RateLimitInfo } from 'express-rate-limit';
import { ApiError } from './api-error.js';

const WINDOW_MS = 60_000;

/**
 * Per-client-IP fixed-window limit (in-memory, per instance). The client IP is
 * `req.ip`, which honours the app's "trust proxy" setting; IPv6 clients are
 * grouped by /56 so one host cannot rotate through its subnet.
 * Emits IETF draft-8 `RateLimit` / `RateLimit-Policy` headers.
 */
export function createRateLimiter(perMinute: number): RequestHandler {
  if (perMinute === 0) return (_req, _res, next) => next();

  return rateLimit({
    windowMs: WINDOW_MS,
    limit: perMinute,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, _res, next) => {
      const info = (req as Request & { rateLimit?: RateLimitInfo }).rateLimit;
      const resetAt = info?.resetTime?.getTime() ?? Date.now() + WINDOW_MS;
      const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
      next(
        new ApiError(
          'RATE_LIMITED',
          `Rate limit of ${perMinute} requests per minute exceeded. Retry in ${retryAfter}s.`,
          { headers: { 'Retry-After': String(retryAfter) } },
        ),
      );
    },
  });
}
