import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFetcher } from '../../src/fetch/fetcher.js';
import type { Fetcher } from '../../src/fetch/fetcher.js';
import { ApiError } from '../../src/http/api-error.js';
import { closedPort, startUpstream, testLookup } from './upstream.js';
import type { Upstream } from './upstream.js';

const MAX_BYTES = 1000;
const MAX_REDIRECTS = 3;

let upstream: Upstream;
let deadPort: number;
let fetcher: Fetcher;

beforeAll(async () => {
  upstream = await startUpstream();
  deadPort = await closedPort();
  fetcher = createFetcher({
    urlPolicy: { allowedHosts: [], allowedPorts: [String(upstream.port), String(deadPort)] },
    lookup: testLookup,
    maxBytes: MAX_BYTES,
    maxRedirects: MAX_REDIRECTS,
    connectTimeoutMs: 500,
    headersTimeoutMs: 300,
    totalTimeoutMs: 800,
  });

  const { routes } = upstream;
  const url = (path: string) => `${upstream.base}${path}`;

  routes.set('/image.png', (res) =>
    res.writeHead(200, { 'Content-Type': 'image/png' }).end('PNGDATA'),
  );
  routes.set('/empty', (res) => res.writeHead(200).end());
  routes.set('/status/404', (res) => res.writeHead(404).end('nope'));
  routes.set('/status/500', (res) => res.writeHead(500).end('boom'));
  routes.set('/status/204', (res) => res.writeHead(204).end());
  routes.set('/status/429', (res) => res.writeHead(429, { 'Retry-After': '60' }).end('slow down'));
  for (const code of [301, 302, 303, 307, 308]) {
    routes.set(`/redirect/${code}`, (res) => res.writeHead(code, { Location: '/image.png' }).end());
  }
  for (let n = 1; n <= MAX_REDIRECTS + 1; n++) {
    const next = n === 1 ? '/image.png' : `/chain/${n - 1}`;
    routes.set(`/chain/${n}`, (res) => res.writeHead(302, { Location: next }).end());
  }
  routes.set('/loop', (res) => res.writeHead(302, { Location: '/loop' }).end());
  routes.set('/no-location', (res) => res.writeHead(302).end());
  routes.set('/to-loopback-ip', (res) =>
    res.writeHead(302, { Location: `http://127.0.0.1:${upstream.port}/image.png` }).end(),
  );
  routes.set('/to-metadata-host', (res) =>
    res.writeHead(302, { Location: `http://evil.test:${upstream.port}/latest/meta-data/` }).end(),
  );
  routes.set('/to-file', (res) => res.writeHead(302, { Location: 'file:///etc/passwd' }).end());
  routes.set('/absolute-redirect', (res) =>
    res.writeHead(302, { Location: url('/image.png') }).end(),
  );
  routes.set('/declared-too-big', (res) => {
    res.writeHead(200, { 'Content-Length': String(MAX_BYTES + 1) });
    res.end(Buffer.alloc(MAX_BYTES + 1));
  });
  routes.set('/chunked-too-big', (res) => {
    // No Content-Length: the limit must be enforced while streaming.
    res.writeHead(200);
    let sent = 0;
    const timer = setInterval(() => {
      if (res.destroyed || sent > MAX_BYTES * 20) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(Buffer.alloc(200));
      sent += 200;
    }, 5);
  });
  routes.set('/exactly-max', (res) => res.writeHead(200).end(Buffer.alloc(MAX_BYTES, 7)));
  routes.set('/slow-headers', (res) => {
    setTimeout(() => res.writeHead(200).end('late'), 2000).unref();
  });
  routes.set('/trickle', (res) => {
    res.writeHead(200);
    const timer = setInterval(() => (res.destroyed ? clearInterval(timer) : res.write('x')), 50);
  });
  routes.set('/gzip', (res) =>
    res.writeHead(200, { 'Content-Encoding': 'gzip' }).end(Buffer.from([0x1f, 0x8b])),
  );
});

afterAll(async () => {
  await fetcher.close();
  await upstream.close();
});

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => {
      throw new Error('expected the fetch to fail');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('fetcher — success', () => {
  it('returns the body bytes and final URL', async () => {
    const result = await fetcher.fetch(`${upstream.base}/image.png`);
    expect(result.bytes.toString()).toBe('PNGDATA');
    expect(result.finalUrl.href).toBe(`${upstream.base}/image.png`);
  });

  it('returns an empty body as-is (rejected later by format detection)', async () => {
    expect((await fetcher.fetch(`${upstream.base}/empty`)).bytes.length).toBe(0);
  });

  it('accepts a body of exactly the size limit', async () => {
    expect((await fetcher.fetch(`${upstream.base}/exactly-max`)).bytes.length).toBe(MAX_BYTES);
  });

  it('identifies itself, asks for images and refuses compressed transfer', async () => {
    await fetcher.fetch(`${upstream.base}/image.png`);
    expect(upstream.lastRequestHeaders).toMatchObject({
      'user-agent': expect.stringMatching(/^image-service\//) as unknown,
      accept: expect.stringMatching(/^image\//) as unknown,
      'accept-encoding': 'identity',
    });
  });

  it('never sends cookies or credentials upstream', async () => {
    await fetcher.fetch(`${upstream.base}/image.png`);
    expect(upstream.lastRequestHeaders).not.toHaveProperty('cookie');
    expect(upstream.lastRequestHeaders).not.toHaveProperty('authorization');
  });
});

describe('fetcher — redirects', () => {
  it.each([301, 302, 303, 307, 308])('follows %i', async (code) => {
    const result = await fetcher.fetch(`${upstream.base}/redirect/${code}`);
    expect(result.bytes.toString()).toBe('PNGDATA');
    expect(result.finalUrl.pathname).toBe('/image.png');
  });

  it('follows absolute Location headers', async () => {
    expect((await fetcher.fetch(`${upstream.base}/absolute-redirect`)).bytes.toString()).toBe(
      'PNGDATA',
    );
  });

  it(`follows up to ${MAX_REDIRECTS} redirects`, async () => {
    const result = await fetcher.fetch(`${upstream.base}/chain/${MAX_REDIRECTS}`);
    expect(result.bytes.toString()).toBe('PNGDATA');
  });

  it(`gives up after ${MAX_REDIRECTS} redirects`, async () => {
    const error = await failure(fetcher.fetch(`${upstream.base}/chain/${MAX_REDIRECTS + 1}`));
    expect(error.code).toBe('TOO_MANY_REDIRECTS');
    expect(error.detail).toMatch(String(MAX_REDIRECTS));
  });

  it('stops redirect loops', async () => {
    expect((await failure(fetcher.fetch(`${upstream.base}/loop`))).code).toBe('TOO_MANY_REDIRECTS');
  });

  it('fails on a redirect without Location', async () => {
    const error = await failure(fetcher.fetch(`${upstream.base}/no-location`));
    expect(error.code).toBe('SOURCE_FETCH_FAILED');
    expect(error.detail).toMatch(/Location/);
  });
});

describe('fetcher — SSRF', () => {
  it('blocks a redirect to an internal IP literal', async () => {
    const error = await failure(fetcher.fetch(`${upstream.base}/to-loopback-ip`));
    expect(error.code).toBe('URL_NOT_ALLOWED');
  });

  it('blocks a redirect to a host that resolves to cloud metadata', async () => {
    const error = await failure(fetcher.fetch(`${upstream.base}/to-metadata-host`));
    expect(error.code).toBe('URL_NOT_ALLOWED');
    expect(error.detail).toMatch(/evil\.test/);
    expect(error.detail).not.toMatch(/169\.254/);
  });

  it('blocks a redirect to a non-http scheme', async () => {
    expect((await failure(fetcher.fetch(`${upstream.base}/to-file`))).code).toBe('URL_NOT_ALLOWED');
  });

  it('blocks a requested host that resolves to an internal address', async () => {
    const error = await failure(fetcher.fetch(`http://evil.test:${upstream.port}/`));
    expect(error.code).toBe('URL_NOT_ALLOWED');
  });

  it('applies the URL policy before any network activity', async () => {
    const before = upstream.lastRequestHeaders;
    upstream.lastRequestHeaders = undefined;
    const error = await failure(fetcher.fetch(`http://img.test:6379/`));
    expect(error.code).toBe('URL_NOT_ALLOWED');
    expect(upstream.lastRequestHeaders).toBeUndefined();
    upstream.lastRequestHeaders = before;
  });
});

describe('fetcher — upstream failures', () => {
  it.each([404, 500, 204])('reports HTTP %i from the source', async (status) => {
    const error = await failure(fetcher.fetch(`${upstream.base}/status/${status}`));
    expect(error.code).toBe('SOURCE_FETCH_FAILED');
    expect(error.detail).toMatch(`HTTP ${status}`);
  });

  it('explains when the source host is rate-limiting this service', async () => {
    const error = await failure(fetcher.fetch(`${upstream.base}/status/429`));
    expect(error.code).toBe('SOURCE_FETCH_FAILED');
    expect(error.detail).toMatch(/rate-limiting this service \(HTTP 429\)/);
    expect(error.detail).toMatch(/try again later/i);
  });

  it('reports hosts that do not resolve', async () => {
    const error = await failure(fetcher.fetch(`http://nxdomain.test:${upstream.port}/`));
    expect(error.code).toBe('SOURCE_FETCH_FAILED');
    expect(error.detail).toMatch(/resolve/);
  });

  it('reports refused connections', async () => {
    const error = await failure(fetcher.fetch(`http://img.test:${deadPort}/`));
    expect(error.code).toBe('SOURCE_FETCH_FAILED');
    expect(error.detail).toMatch(/connect/);
  });

  it('rejects compressed responses instead of inflating them', async () => {
    const error = await failure(fetcher.fetch(`${upstream.base}/gzip`));
    expect(error.code).toBe('SOURCE_FETCH_FAILED');
    expect(error.detail).toMatch(/gzip/);
  });
});

describe('fetcher — size limit', () => {
  it('rejects early when Content-Length is over the limit', async () => {
    const error = await failure(fetcher.fetch(`${upstream.base}/declared-too-big`));
    expect(error.code).toBe('SOURCE_TOO_LARGE');
    expect(error.detail).toMatch(String(MAX_BYTES));
  });

  it('stops downloading once a streamed body passes the limit', async () => {
    const error = await failure(fetcher.fetch(`${upstream.base}/chunked-too-big`));
    expect(error.code).toBe('SOURCE_TOO_LARGE');
    await expect.poll(() => upstream.abortedResponses).toContain('/chunked-too-big');
  });
});

describe('fetcher — timeouts and cancellation', () => {
  it('times out waiting for response headers', async () => {
    const error = await failure(fetcher.fetch(`${upstream.base}/slow-headers`));
    expect(error.code).toBe('SOURCE_TIMEOUT');
  });

  it('applies the per-phase headers timeout even when the total deadline is generous', async () => {
    const patient = createFetcher({
      urlPolicy: { allowedHosts: [], allowedPorts: [String(upstream.port)] },
      lookup: testLookup,
      maxBytes: MAX_BYTES,
      maxRedirects: MAX_REDIRECTS,
      connectTimeoutMs: 500,
      headersTimeoutMs: 100,
      totalTimeoutMs: 5000,
    });
    const error = await failure(patient.fetch(`${upstream.base}/slow-headers`));
    await patient.close();
    expect(error.code).toBe('SOURCE_TIMEOUT');
    expect(error.detail).toMatch(/took too long/);
  });

  it('enforces a total deadline on slowly trickling bodies', async () => {
    const started = Date.now();
    const error = await failure(fetcher.fetch(`${upstream.base}/trickle`));
    expect(error.code).toBe('SOURCE_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('does not hang when DNS never answers', async () => {
    const error = await failure(fetcher.fetch(`http://hang.test:${upstream.port}/`));
    expect(error.code).toBe('SOURCE_TIMEOUT');
  });

  it('stops when the caller aborts and surfaces the abort, not an API error', async () => {
    const controller = new AbortController();
    const pending = fetcher.fetch(`${upstream.base}/trickle`, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const error = await pending.catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ name: 'AbortError' });
  });
});
