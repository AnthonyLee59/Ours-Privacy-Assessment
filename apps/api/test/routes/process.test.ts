import { isProblemDetails } from '@image-service/contract';
import type { ServerResponse } from 'node:http';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import { createFetcher } from '../../src/fetch/fetcher.js';
import { downloadName } from '../../src/routes/process.js';
import type { Fetcher } from '../../src/fetch/fetcher.js';
import { silentLogger, testConfig } from '../helpers.js';
import { startUpstream, testLookup } from '../fetch/upstream.js';
import type { Upstream } from '../fetch/upstream.js';
import { jpeg, png } from '../image/fixtures.js';

let upstream: Upstream;
const fetchers: Fetcher[] = [];

/** App wired to the local upstream through the real fetcher and SSRF lookup. */
function appWith(overrides: Partial<Config> = {}) {
  const config = { ...testConfig, ...overrides };
  const urlPolicy = { allowedHosts: [], allowedPorts: [String(upstream.port)] };
  const fetcher = createFetcher({
    urlPolicy,
    lookup: testLookup,
    maxBytes: config.maxSourceBytes,
    maxRedirects: config.maxRedirects,
    connectTimeoutMs: 1000,
    headersTimeoutMs: 2000,
    totalTimeoutMs: config.fetchTimeoutMs,
  });
  fetchers.push(fetcher);
  return createApp({ config, logger: silentLogger, fetcher, urlPolicy });
}

const src = (path: string) => encodeURIComponent(`${upstream.base}${path}`);

beforeAll(async () => {
  upstream = await startUpstream();
  const photo = await jpeg(1000, 800);
  const logo = await png(400, 200);
  const serve =
    (body: Buffer, type: string, delayMs = 0) =>
    (res: ServerResponse) =>
      setTimeout(() => res.writeHead(200, { 'Content-Type': type }).end(body), delayMs);

  upstream.routes.set('/photo.jpg', serve(photo, 'image/jpeg'));
  upstream.routes.set('/images/My%20Holiday.final.png', serve(logo, 'image/png'));
  upstream.routes.set('/logo.png', serve(logo, 'image/png'));
  upstream.routes.set('/', serve(logo, 'image/png'));
  upstream.routes.set('/logo.png?v=2', serve(logo, 'image/png'));
  upstream.routes.set('/slow-a.png', serve(logo, 'image/png', 300));
  upstream.routes.set('/slow-b.png', serve(logo, 'image/png', 300));
  upstream.routes.set('/page.html', serve(Buffer.from('<!doctype html><p>hi'), 'text/html'));
});

afterAll(async () => {
  await Promise.all(fetchers.map((f) => f.close()));
  await upstream.close();
});

async function imageOf(body: Buffer) {
  const { width, height, format } = await sharp(body).metadata();
  return { width, height, format };
}

describe('GET /process — PDF example requests, verbatim paths', () => {
  it('resizes: /process?url=...&width=500&height=300', async () => {
    const res = await request(appWith()).get(
      `/process?url=${src('/photo.jpg')}&width=500&height=300`,
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    // Default crop=fit keeps the 5:4 aspect inside the 500x300 box.
    expect(await imageOf(res.body as Buffer)).toEqual({ width: 375, height: 300, format: 'jpeg' });
  });

  it('converts: /process?url=...png&format=jpeg&quality=80', async () => {
    const res = await request(appWith()).get(
      `/process?url=${src('/logo.png')}&format=jpeg&quality=80`,
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect((await imageOf(res.body as Buffer)).format).toBe('jpeg');
  });

  it('combines: /process?url=...&width=800&height=600&format=webp&crop=fill', async () => {
    const res = await request(appWith()).get(
      `/process?url=${src('/photo.jpg')}&width=800&height=600&format=webp&crop=fill`,
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(await imageOf(res.body as Buffer)).toEqual({ width: 800, height: 600, format: 'webp' });
  });
});

describe('GET /v1/process — response headers', () => {
  it('is the canonical path and behaves like /process', async () => {
    const res = await request(appWith()).get(`/v1/process?url=${src('/logo.png')}&width=100`);
    expect(res.status).toBe(200);
    expect(await imageOf(res.body as Buffer)).toEqual({ width: 100, height: 50, format: 'png' });
  });

  it('describes the source and the result', async () => {
    const res = await request(appWith()).get(
      `/v1/process?url=${src('/photo.jpg')}&width=100&format=webp`,
    );
    expect(res.headers).toMatchObject({
      'x-source-width': '1000',
      'x-source-height': '800',
      'x-source-format': 'jpeg',
      'x-output-width': '100',
      'x-output-height': '80',
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
    });
    expect(Number(res.headers['x-source-bytes'])).toBeGreaterThan(0);
    expect(Number(res.headers['content-length'])).toBe((res.body as Buffer).length);
    expect(res.headers.etag).toMatch(/^"[\w-]+"$/);
  });

  it('suggests a filename derived from the source with the new extension', async () => {
    const res = await request(appWith()).get(
      `/v1/process?url=${src('/images/My%20Holiday.final.png')}&format=webp`,
    );
    expect(res.headers['content-disposition']).toBe('inline; filename="My_Holiday.final.webp"');
  });

  it('ignores the source query string when naming the file', async () => {
    const res = await request(appWith()).get(`/v1/process?url=${src('/logo.png?v=2')}&format=jpeg`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('inline; filename="logo.jpg"');
  });

  it('falls back to a generic filename when the path has none', async () => {
    const res = await request(appWith()).get(`/v1/process?url=${src('/')}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('inline; filename="image.png"');
  });

  it('reports cache MISS then HIT', async () => {
    const app = appWith();
    const path = `/v1/process?url=${src('/logo.png')}&width=77`;
    expect((await request(app).get(path)).headers['x-cache']).toBe('MISS');
    const second = await request(app).get(path);
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.status).toBe(200);
  });

  it('answers 304 Not Modified to a matching If-None-Match', async () => {
    const app = appWith();
    const path = `/v1/process?url=${src('/logo.png')}&width=66`;
    const first = await request(app).get(path);
    const second = await request(app)
      .get(path)
      .set('If-None-Match', first.headers.etag as string);
    expect(second.status).toBe(304);
    expect(second.headers.etag).toBe(first.headers.etag);
    expect(second.text ?? '').toBe('');
  });

  it('supports HEAD with headers but no body', async () => {
    const res = await request(appWith()).head(`/v1/process?url=${src('/logo.png')}&width=10`);
    expect(res.status).toBe(200);
    expect(Number(res.headers['content-length'])).toBeGreaterThan(0);
    expect(res.body).toEqual({});
  });
});

describe('GET /v1/process — errors', () => {
  async function problem(path: string, app = appWith()) {
    const res = await request(app).get(path);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(isProblemDetails(res.body)).toBe(true);
    return res;
  }

  it('lists every invalid parameter with a summary', async () => {
    const res = await problem(`/v1/process?url=${src('/logo.png')}&width=0&crop=nope`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PARAMETER');
    expect(res.body.detail).toMatch(/2 parameters are invalid: width, crop/);
    expect((res.body.errors as { param: string }[]).map((e) => e.param)).toEqual(['width', 'crop']);
  });

  it('uses the single message as detail when one parameter is invalid', async () => {
    const res = await problem('/v1/process?width=10');
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/url is required/);
  });

  it('explains what is missing when called with no query string', async () => {
    const res = await problem('/v1/process');
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual([{ param: 'url', message: expect.stringMatching(/required/) }]);
  });

  it('refuses internal addresses with URL_NOT_ALLOWED', async () => {
    const res = await problem(
      `/v1/process?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('URL_NOT_ALLOWED');
  });

  it('reports an upstream 404 as 502 SOURCE_FETCH_FAILED', async () => {
    const res = await problem(`/v1/process?url=${src('/nope.png')}`);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('SOURCE_FETCH_FAILED');
    expect(res.body.detail).toMatch(/HTTP 404/);
  });

  it('reports non-images as 415', async () => {
    const res = await problem(`/v1/process?url=${src('/page.html')}`);
    expect(res.status).toBe(415);
    expect(res.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects other methods with 405', async () => {
    const res = await request(appWith()).post(`/v1/process?url=${src('/logo.png')}`);
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('GET, HEAD');
  });

  it('sheds load with 503 and Retry-After when saturated', async () => {
    const app = appWith({ processingConcurrency: 1, processingQueueSize: 0 });
    const [a, b] = await Promise.all([
      request(app).get(`/v1/process?url=${src('/slow-a.png')}`),
      request(app).get(`/v1/process?url=${src('/slow-b.png')}`),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 503]);
    const busy = a.status === 503 ? a : b;
    expect(busy.body.code).toBe('SERVER_BUSY');
    expect(busy.headers['retry-after']).toBe('2');
  });
});

describe('downloadName', () => {
  it.each([
    ['https://x.test/a/b/cat.png', 'webp', 'cat.webp'],
    ['https://x.test/My%20Photo.JPEG', 'jpeg', 'My_Photo.jpg'],
    ['https://x.test/%E0%A4%A.png', 'png', '_E0_A4_A.png'],
    ['https://x.test/"quoted";.png', 'png', '_quoted_.png'],
    ['https://x.test/', 'gif', 'image.gif'],
    [`https://x.test/${'a'.repeat(200)}.png`, 'png', `${'a'.repeat(64)}.png`],
  ] as const)('%s as %s -> %s', (url, format, expected) => {
    expect(downloadName(url, format)).toBe(expected);
  });
});
