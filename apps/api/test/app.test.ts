import { isProblemDetails } from '@image-service/contract';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { memoryLogger, silentLogger, testConfig } from './helpers.js';

const app = createApp({ config: testConfig, logger: silentLogger });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('GET /healthz', () => {
  it('reports ok and is never cached', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('supports HEAD for cheap probes', async () => {
    const res = await request(app).head('/healthz');
    expect(res.status).toBe(200);
  });

  it('rejects other methods with 405 and an Allow header', async () => {
    const res = await request(app).post('/healthz');
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('GET, HEAD');
    expect(res.body.code).toBe('METHOD_NOT_ALLOWED');
  });
});

describe('GET /video/thumbnail', () => {
  it('answers 501 with a problem body explaining it is not supported', async () => {
    const res = await request(app).get('/video/thumbnail?url=https://example.com/v.mp4&time=15');
    expect(res.status).toBe(501);
    expect(isProblemDetails(res.body)).toBe(true);
    expect(res.body.code).toBe('NOT_IMPLEMENTED');
    expect(res.body.detail).toMatch(/video/i);
  });
});

describe('unknown routes', () => {
  it('return a 404 problem body', async () => {
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(isProblemDetails(res.body)).toBe(true);
  });
});

describe('request ids', () => {
  it('generates a UUID and returns it in header and error body', async () => {
    const res = await request(app).get('/does-not-exist');
    expect(res.headers['x-request-id']).toMatch(UUID);
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('propagates a well-formed inbound X-Request-Id', async () => {
    const res = await request(app).get('/healthz').set('X-Request-Id', 'edge-abc_123.4');
    expect(res.headers['x-request-id']).toBe('edge-abc_123.4');
  });

  it.each([
    ['too long', 'a'.repeat(129)],
    ['unsafe characters', '../../etc/passwd'],
    ['log injection attempt', 'id" level=60 msg="pwned'],
  ])('replaces an inbound id that is %s', async (_label, inbound) => {
    const res = await request(app).get('/healthz').set('X-Request-Id', inbound);
    expect(res.headers['x-request-id']).toMatch(UUID);
  });
});

describe('security headers', () => {
  it('does not advertise the framework', async () => {
    const res = await request(app).get('/healthz');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sets nosniff', async () => {
    const res = await request(app).get('/healthz');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('allows processed images to be embedded cross-origin', async () => {
    // helmet defaults CORP to same-origin, which would break <img> embeds on other sites.
    const res = await request(app).get('/healthz');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });
});

describe('CORS', () => {
  it('allows any origin to read responses', async () => {
    const res = await request(app).get('/healthz').set('Origin', 'https://someone-else.dev');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('exposes headers clients need', async () => {
    const res = await request(app).get('/healthz').set('Origin', 'https://someone-else.dev');
    const exposed = String(res.headers['access-control-expose-headers']).split(/,\s*/);
    expect(exposed).toEqual(
      expect.arrayContaining([
        'X-Request-Id',
        'X-Cache',
        'X-Source-Width',
        'X-Output-Width',
        'X-Output-Height',
        'Retry-After',
        'ETag',
      ]),
    );
  });

  it('answers preflight for read-only methods only', async () => {
    const res = await request(app)
      .options('/v1/process')
      .set('Origin', 'https://someone-else.dev')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']).toBe('GET,HEAD');
  });
});

describe('request logging', () => {
  const PINO_LEVEL = { info: 30, warn: 40, error: 50 };

  async function levelFor(path: string) {
    const { logger, entries } = memoryLogger();
    await request(createApp({ config: testConfig, logger })).get(path);
    return entries.find(
      (entry) => entry.msg === 'request completed' || entry.msg === 'request errored',
    )?.level;
  }

  it('logs successful requests at info', async () => {
    expect(await levelFor('/healthz')).toBe(PINO_LEVEL.info);
  });

  it('logs client errors at warn', async () => {
    expect(await levelFor('/nope')).toBe(PINO_LEVEL.warn);
  });

  it('logs deliberate 5xx answers (not faults) at warn', async () => {
    expect(await levelFor('/video/thumbnail')).toBe(PINO_LEVEL.warn);
  });
});
