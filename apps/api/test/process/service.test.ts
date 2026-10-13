import type { ProcessParams } from '@image-service/contract';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createResultCache } from '../../src/cache/memory-cache.js';
import type { Fetcher } from '../../src/fetch/fetcher.js';
import { ApiError } from '../../src/http/api-error.js';
import { createLimiter } from '../../src/process/limiter.js';
import { createProcessService } from '../../src/process/service.js';
import { png } from '../image/fixtures.js';

/** In-memory stand-in for the network fetcher; counts calls and can be held open. */
function fakeFetcher(body: () => Promise<Buffer>) {
  let calls = 0;
  let gate: Promise<void> = Promise.resolve();
  const fetcher: Fetcher = {
    async fetch(url) {
      calls++;
      await gate;
      return { bytes: await body(), finalUrl: new URL(String(url)) };
    },
    close: () => Promise.resolve(),
  };
  return {
    fetcher,
    calls: () => calls,
    hold() {
      let release!: () => void;
      gate = new Promise((resolve) => (release = resolve));
      return release;
    },
  };
}

function service(fetcher: Fetcher, overrides: { cacheMaxBytes?: number } = {}) {
  return createProcessService({
    fetcher,
    cache: createResultCache({ maxBytes: overrides.cacheMaxBytes ?? 10_000_000, ttlMs: 60_000 }),
    limiter: createLimiter({ concurrency: 2, maxQueue: 10 }),
    imageLimits: { maxInputPixels: 40_000_000, timeoutSeconds: 10 },
    urlPolicy: { allowedHosts: [] },
  });
}

const params: ProcessParams = { url: 'https://example.com/a.png', width: 50, crop: 'fit' };

describe('createProcessService', () => {
  it('fetches and processes on a miss, then serves the cache on a hit', async () => {
    const fake = fakeFetcher(() => png(200, 100));
    const svc = service(fake.fetcher);

    const first = await svc.process(params);
    expect(first.cache).toBe('MISS');
    expect(first.image).toMatchObject({ width: 50, height: 25, format: 'png' });
    expect((await sharp(first.image.bytes).metadata()).width).toBe(50);

    const second = await svc.process({ ...params });
    expect(second.cache).toBe('HIT');
    expect(second.image.etag).toBe(first.image.etag);
    expect(fake.calls()).toBe(1);
  });

  it('gives each distinct output a distinct strong ETag', async () => {
    const svc = service(fakeFetcher(() => png(200, 100)).fetcher);
    const a = await svc.process(params);
    const b = await svc.process({ ...params, width: 60 });
    expect(a.image.etag).toMatch(/^"[\w-]+"$/);
    expect(a.image.etag).not.toBe(b.image.etag);
  });

  it('coalesces concurrent identical requests into one fetch', async () => {
    const fake = fakeFetcher(() => png(200, 100));
    const svc = service(fake.fetcher);
    const release = fake.hold();

    const pending = Promise.all([svc.process(params), svc.process(params), svc.process(params)]);
    release();
    const results = await pending;

    expect(fake.calls()).toBe(1);
    expect(new Set(results.map((r) => r.image.etag)).size).toBe(1);
  });

  it('still coalesces when caching is disabled', async () => {
    const fake = fakeFetcher(() => png(200, 100));
    const svc = service(fake.fetcher, { cacheMaxBytes: 0 });
    const release = fake.hold();
    const pending = Promise.all([svc.process(params), svc.process(params)]);
    release();
    await pending;
    expect(fake.calls()).toBe(1);
    await svc.process(params);
    expect(fake.calls()).toBe(2);
  });

  it('does not cache failures, so a later retry fetches again', async () => {
    let attempt = 0;
    const fake = fakeFetcher(() =>
      ++attempt === 1 ? Promise.resolve(Buffer.from('<html>oops</html>')) : png(10, 10),
    );
    const svc = service(fake.fetcher);

    await expect(svc.process(params)).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    expect((await svc.process(params)).cache).toBe('MISS');
    expect(fake.calls()).toBe(2);
  });

  it('rejects disallowed URLs before fetching or touching the cache', async () => {
    const fake = fakeFetcher(() => png(10, 10));
    const svc = service(fake.fetcher);
    const error = await svc
      .process({ ...params, url: 'http://169.254.169.254/' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'URL_NOT_ALLOWED' });
    expect(fake.calls()).toBe(0);
  });
});
