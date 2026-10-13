import { ERRORS, PROBLEM_CONTENT_TYPE, problemType } from '@image-service/contract';
import type { ProblemDetails } from '@image-service/contract';
import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import type { Logger } from 'pino';
import { ApiError } from './api-error.js';

/** pino-http assigns ids via assignRequestId, which always returns a string. */
function requestIdOf(req: Request): string {
  return typeof req.id === 'string' ? req.id : 'unknown';
}

function sendProblem(req: Request, res: Response, error: ApiError): void {
  const { status, title } = ERRORS[error.code];
  const body: ProblemDetails = {
    type: problemType(error.code),
    title,
    status,
    detail: error.detail,
    code: error.code,
    instance: req.path,
    requestId: requestIdOf(req),
    ...(error.errors && { errors: error.errors }),
  };
  res
    .status(status)
    .set({ ...error.headers, 'Cache-Control': 'no-store' })
    .type(PROBLEM_CONTENT_TYPE)
    .send(JSON.stringify(body));
}

/** Client errors raised by Express/body parsers carry a 4xx `status` and `expose: true`. */
function isExposedClientError(error: unknown): error is Error & { status: number } {
  if (!(error instanceof Error)) return false;
  const { status, expose } = error as { status?: unknown; expose?: unknown };
  return typeof status === 'number' && status >= 400 && status < 500 && expose === true;
}

export const notFoundHandler: RequestHandler = (req) => {
  throw new ApiError(
    'NOT_FOUND',
    `No route for ${req.method} ${req.path}. See /docs for available endpoints.`,
  );
};

export function methodNotAllowed(allowed: string[]): RequestHandler {
  const allow = allowed.join(', ');
  return (req) => {
    throw new ApiError('METHOD_NOT_ALLOWED', `${req.method} is not supported here. Use ${allow}.`, {
      headers: { Allow: allow },
    });
  };
}

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    if (res.headersSent) {
      // Too late for a clean error body; let Express abort the connection.
      next(error);
      return;
    }
    if (error instanceof ApiError) {
      sendProblem(req, res, error);
      return;
    }
    if (isExposedClientError(error)) {
      sendProblem(
        req,
        res,
        new ApiError('INVALID_PARAMETER', `Malformed request: ${error.message}`),
      );
      return;
    }
    (req.log ?? logger).error({ err: error }, 'unhandled error');
    sendProblem(
      req,
      res,
      new ApiError(
        'INTERNAL',
        `Something went wrong on our side. Quote request id ${requestIdOf(req)} when reporting this.`,
      ),
    );
  };
}
