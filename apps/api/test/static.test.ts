import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resolveStaticDir } from '../src/static.js';
import { silentLogger, testConfig } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'web-dist-'));
mkdirSync(join(dir, 'assets'));
writeFileSync(
  join(dir, 'index.html'),
  '<!doctype html><title>UI</title><script type="module" src="/assets/app-1a2b.js"></script>',
);
writeFileSync(join(dir, 'assets', 'app-1a2b.js'), 'console.log("ui")');
writeFileSync(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const app = createApp({ config: { ...testConfig, staticDir: dir }, logger: silentLogger });

describe('serving the built UI', () => {
  it('serves index.html at / and never caches it (so deploys show up immediately)', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.text).toContain('<title>UI</title>');
  });

  it('caches content-hashed assets for a year', async () => {
    const res = await request(app).get('/assets/app-1a2b.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('caches other public files briefly', async () => {
    const res = await request(app).get('/favicon.svg');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
  });

  it('lets the UI preview images from any http(s) host and blob: URLs, but nothing else is loosened', async () => {
    const csp = String((await request(app).get('/')).headers['content-security-policy']);
    expect(csp).toMatch(/img-src 'self' data: blob: http: https:/);
    expect(csp).toMatch(/script-src 'self'(;|$)/);
    expect(csp).toMatch(/style-src 'self'(;|$)/);
    expect(csp).toMatch(/connect-src 'self'/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  });

  it('keeps API routes working and unaffected by the UI policy', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(String(res.headers['content-security-policy'])).not.toMatch(/img-src[^;]*http:/);
  });

  it('returns a problem 404 for unknown paths', async () => {
    const res = await request(app).get('/nope.html');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it.each(['/..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/assets/..%2f..%2findex.html'])(
    'does not escape the static directory: %s',
    async (path) => {
      const res = await request(app).get(path);
      expect([400, 403, 404]).toContain(res.status);
      expect(res.text).not.toMatch(/"name":/);
    },
  );

  it('does not serve dotfiles', async () => {
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    const res = await request(app).get('/.env');
    expect(res.status).toBe(404);
  });
});

describe('without a built UI', () => {
  it('serves the API only', async () => {
    const apiOnly = createApp({
      config: { ...testConfig, staticDir: undefined },
      logger: silentLogger,
    });
    expect((await request(apiOnly).get('/')).status).toBe(404);
    expect((await request(apiOnly).get('/healthz')).status).toBe(200);
  });
});

describe('resolveStaticDir', () => {
  it('uses the configured directory when it exists', () => {
    expect(resolveStaticDir(dir, '/does/not/exist')).toBe(dir);
  });

  it('throws when a configured directory is missing (fail fast on misconfiguration)', () => {
    expect(() => resolveStaticDir('/does/not/exist', dir)).toThrow(/STATIC_DIR/);
  });

  it('falls back to the default build location when present', () => {
    expect(resolveStaticDir(undefined, dir)).toBe(dir);
  });

  it('serves no UI when nothing is configured or built', () => {
    expect(resolveStaticDir(undefined, '/does/not/exist')).toBeUndefined();
  });
});
