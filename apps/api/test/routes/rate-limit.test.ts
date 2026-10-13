import { isProblemDetails } from '@image-service/contract';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import { silentLogger, testConfig } from '../helpers.js';

const LIMIT = 3;
// Invalid requests are cheap (no fetch) and still count against the limit.
const CHEAP = '/v1/process?width=1';

function appWith(overrides: Partial<Config> = {}) {
  return createApp({
    config: { ...testConfig, rateLimitPerMinute: LIMIT, ...overrides },
    logger: silentLogger,
  });
}

async function exhaust(app: ReturnType<typeof appWith>, path = CHEAP, ip?: string) {
  for (let i = 0; i < LIMIT; i++) {
    const req = request(app).get(path);
    const res = ip ? await req.set('X-Forwarded-For', ip) : await req;
    expect(res.status).toBe(400);
  }
}

afterEach(() => vi.restoreAllMocks());

describe('rate limiting on processing routes', () => {
  it(`answers 429 problem+json after ${LIMIT} requests per minute`, async () => {
    const app = appWith();
    await exhaust(app);
    const res = await request(app).get(CHEAP).set('Origin', 'https://someone.dev');

    expect(res.status).toBe(429);
    expect(isProblemDetails(res.body)).toBe(true);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(res.body.detail).toMatch(new RegExp(`${LIMIT} requests per minute`));
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(res.headers['cache-control']).toBe('no-store');
    // Browsers must be able to read the 429 body from other origins (e.g. the UI).
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('advertises the quota with IETF RateLimit headers', async () => {
    const res = await request(appWith()).get(CHEAP);
    expect(res.headers['ratelimit-policy']).toMatch(new RegExp(`q=${LIMIT}`));
    expect(res.headers.ratelimit).toMatch(new RegExp(`r=${LIMIT - 1}`));
  });

  it('shares one budget between /process and /v1/process', async () => {
    const app = appWith();
    await request(app).get('/process?width=1');
    await request(app).get('/v1/process?width=1');
    await request(app).get('/process?width=1');
    expect((await request(app).get('/v1/process?width=1')).status).toBe(429);
  });

  it('does not limit the health check', async () => {
    const app = appWith();
    await exhaust(app);
    expect((await request(app).get('/healthz')).status).toBe(200);
  });

  it('is disabled when the limit is 0', async () => {
    const app = appWith({ rateLimitPerMinute: 0 });
    for (let i = 0; i < LIMIT * 3; i++) {
      expect((await request(app).get(CHEAP)).status).toBe(400);
    }
  });
});

describe('client identity and TRUST_PROXY', () => {
  it('keeps separate budgets per client IP behind a trusted proxy', async () => {
    const app = appWith({ trustProxy: 1 });
    await exhaust(app, CHEAP, '203.0.113.1');
    expect((await request(app).get(CHEAP).set('X-Forwarded-For', '203.0.113.1')).status).toBe(429);
    expect((await request(app).get(CHEAP).set('X-Forwarded-For', '203.0.113.2')).status).toBe(400);
  });

  it('ignores X-Forwarded-For when no proxy is trusted, so clients cannot rotate it to escape', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = appWith({ trustProxy: false });
    for (let i = 0; i < LIMIT; i++) {
      await request(app).get(CHEAP).set('X-Forwarded-For', `198.51.100.${i}`);
    }
    const res = await request(app).get(CHEAP).set('X-Forwarded-For', '198.51.100.99');
    expect(res.status).toBe(429);
    // express-rate-limit tells operators they probably forgot TRUST_PROXY.
    expect(warn.mock.calls.flat().join(' ')).toMatch(/X-Forwarded-For/);
  });
});
