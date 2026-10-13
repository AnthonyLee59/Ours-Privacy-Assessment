import { isProblemDetails, problemType } from '@image-service/contract';
import express from 'express';
import { pinoHttp } from 'pino-http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/http/api-error.js';
import { createErrorHandler, notFoundHandler } from '../src/http/error-handler.js';
import { memoryLogger, silentLogger } from './helpers.js';

/** Minimal app with one route that throws whatever the test hands it. */
function appThatThrows(error: unknown, logger = silentLogger) {
  const app = express();
  app.use(pinoHttp({ logger, genReqId: () => 'req-123' }));
  app.get('/boom', () => {
    throw error;
  });
  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}

describe('error handler', () => {
  it('renders ApiError as RFC 9457 problem+json', async () => {
    const res = await request(
      appThatThrows(
        new ApiError('INVALID_PARAMETER', 'Fix the width parameter', {
          errors: [{ param: 'width', message: 'width must be between 1 and 4000' }],
        }),
      ),
    ).get('/boom?x=1');

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      type: problemType('INVALID_PARAMETER'),
      title: 'Invalid request parameter',
      status: 400,
      detail: 'Fix the width parameter',
      code: 'INVALID_PARAMETER',
      instance: '/boom',
      requestId: 'req-123',
      errors: [{ param: 'width', message: 'width must be between 1 and 4000' }],
    });
    expect(isProblemDetails(res.body)).toBe(true);
  });

  it('applies extra headers carried by the ApiError', async () => {
    const res = await request(
      appThatThrows(
        new ApiError('SERVER_BUSY', 'Try again shortly', { headers: { 'Retry-After': '5' } }),
      ),
    ).get('/boom');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
  });

  it('hides internals of unexpected errors and logs them', async () => {
    const { logger, entries } = memoryLogger();
    const res = await request(appThatThrows(new Error('db password is hunter2'), logger)).get(
      '/boom',
    );

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL');
    expect(res.body.detail).toMatch(/req-123/);
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|at .*\.ts/);
    const logged = entries.find((entry) => entry.level === 50);
    expect(JSON.stringify(logged)).toMatch(/hunter2/);
  });

  it('treats non-Error throws as internal errors', async () => {
    const res = await request(appThatThrows('just a string')).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL');
  });

  it('maps client errors raised by Express internals to INVALID_PARAMETER', async () => {
    const parseError = Object.assign(new Error('request aborted'), { status: 400, expose: true });
    const res = await request(appThatThrows(parseError)).get('/boom');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PARAMETER');
  });

  it('does not trust 5xx status codes attached to unknown errors', async () => {
    const res = await request(appThatThrows(Object.assign(new Error('x'), { status: 503 }))).get(
      '/boom',
    );
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL');
  });

  it('returns NOT_FOUND problem for unknown routes and names the path', async () => {
    const res = await request(appThatThrows(new Error())).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.detail).toMatch(/GET \/nope/);
  });

  it('aborts the connection when an error happens after the response started', async () => {
    const app = express();
    app.get('/partial', (_req, res) => {
      res.status(200).write('half an ima');
      throw new Error('encoder crashed mid-stream');
    });
    app.use(createErrorHandler(silentLogger));
    // A truncated 200 must not look like success: the socket is torn down instead.
    await expect(request(app).get('/partial')).rejects.toThrow();
  });

  it('still answers when no request id was assigned', async () => {
    const app = express();
    app.get('/boom', () => {
      throw new ApiError('NOT_IMPLEMENTED', 'nope');
    });
    app.use(createErrorHandler(silentLogger));
    const res = await request(app).get('/boom');
    expect(res.status).toBe(501);
    expect(res.body.requestId).toBe('unknown');
  });
});
