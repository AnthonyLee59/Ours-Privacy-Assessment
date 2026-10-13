import { ImageApiError, ImageClient } from '@image-service/sdk';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createFetcher } from '../src/fetch/fetcher.js';
import type { Fetcher } from '../src/fetch/fetcher.js';
import { startServer } from '../src/server.js';
import type { RunningServer } from '../src/server.js';
import { startUpstream, testLookup } from './fetch/upstream.js';
import type { Upstream } from './fetch/upstream.js';
import { silentLogger, testConfig } from './helpers.js';
import { jpeg } from './image/fixtures.js';

/** The real SDK against the real server over HTTP: proves headers and error bodies line up. */
let upstream: Upstream;
let fetcher: Fetcher;
let server: RunningServer;
let client: ImageClient;

beforeAll(async () => {
  upstream = await startUpstream();
  const photo = await jpeg(640, 480);
  upstream.routes.set('/photo.jpg', (res) => res.writeHead(200).end(photo));
  upstream.routes.set('/page.html', (res) => res.writeHead(200).end('<!doctype html>'));

  const urlPolicy = { allowedHosts: [], allowedPorts: [String(upstream.port)] };
  fetcher = createFetcher({
    urlPolicy,
    lookup: testLookup,
    maxBytes: testConfig.maxSourceBytes,
    maxRedirects: 3,
    connectTimeoutMs: 1000,
    headersTimeoutMs: 2000,
    totalTimeoutMs: 5000,
  });
  const app = createApp({ config: testConfig, logger: silentLogger, fetcher, urlPolicy });
  server = await startServer(app, { host: '127.0.0.1', port: 0 });
  client = new ImageClient({ baseUrl: server.url });
});

afterAll(async () => {
  await server.close();
  await fetcher.close();
  await upstream.close();
});

describe('SDK against the running API', () => {
  it('processes an image and reports output and source details', async () => {
    const result = await client.process({
      url: `${upstream.base}/photo.jpg`,
      width: 320,
      format: 'webp',
    });
    expect(result).toMatchObject({
      format: 'webp',
      contentType: 'image/webp',
      width: 320,
      height: 240,
      cache: 'MISS',
      source: { format: 'jpeg', width: 640, height: 480 },
    });
    expect(result.etag).toMatch(/^"/);
    expect(result.requestId).toBeTruthy();
    const meta = await sharp(Buffer.from(await result.blob.arrayBuffer())).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([320, 240, 'webp']);
  });

  it('turns server problems into typed errors', async () => {
    const error = await client
      .process({ url: `${upstream.base}/page.html` })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImageApiError);
    expect(error).toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      status: 415,
      isRetryable: false,
    });
    expect((error as ImageApiError).requestId).toBeTruthy();
  });

  it('builds URLs the server accepts for an <img src>', async () => {
    const res = await fetch(client.url({ url: `${upstream.base}/photo.jpg`, height: 100 }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-output-height')).toBe('100');
  });
});
