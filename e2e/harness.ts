/**
 * E2E test server: the real app (API + built UI) wired exactly like production,
 * except DNS. A local "upstream" serves fixture images under the fake host
 * img.test; the injected test lookup lets only that host resolve to loopback.
 * There is deliberately no production flag for this: it is test-only wiring.
 */
import { fileURLToPath } from 'node:url';
import { createApp } from '../apps/api/src/app.js';
import { loadConfig } from '../apps/api/src/config.js';
import { createFetcher } from '../apps/api/src/fetch/fetcher.js';
import { createLogger } from '../apps/api/src/logger.js';
import { startServer } from '../apps/api/src/server.js';
import { startUpstream, testLookup } from '../apps/api/test/fetch/upstream.js';
import { jpeg, transparentPng } from '../apps/api/test/image/fixtures.js';

const APP_PORT = 4598;
const UPSTREAM_PORT = 4599;

const upstream = await startUpstream(UPSTREAM_PORT);
const [photo, logo] = await Promise.all([jpeg(800, 600), transparentPng(300, 300)]);
upstream.routes.set('/photo.jpg', (res) =>
  res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(photo),
);
upstream.routes.set('/logo.png', (res) =>
  res.writeHead(200, { 'Content-Type': 'image/png' }).end(logo),
);
upstream.routes.set('/page.html', (res) =>
  res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><p>Not an image</p>'),
);

const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  // Both browser projects share one client IP; keep the limit out of the way.
  RATE_LIMIT_PER_MINUTE: '1000',
  STATIC_DIR: fileURLToPath(new URL('../apps/web/dist', import.meta.url)),
});
const urlPolicy = { allowedHosts: [], allowedPorts: [String(UPSTREAM_PORT)] };
const fetcher = createFetcher({
  urlPolicy,
  lookup: testLookup,
  maxBytes: config.maxSourceBytes,
  maxRedirects: config.maxRedirects,
  connectTimeoutMs: 2000,
  headersTimeoutMs: 3000,
  totalTimeoutMs: config.fetchTimeoutMs,
});
const app = createApp({ config, logger: createLogger(config), fetcher, urlPolicy });
const running = await startServer(app, { host: '127.0.0.1', port: APP_PORT });
console.log(`e2e app on ${running.url}, upstream on ${upstream.base}`);

const stop = () => {
  void Promise.all([running.close(), fetcher.close(), upstream.close()]).then(() =>
    process.exit(0),
  );
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
