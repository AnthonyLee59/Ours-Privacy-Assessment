import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const MB = 1024 * 1024;

describe('loadConfig', () => {
  it('uses safe defaults when nothing is set', () => {
    expect(loadConfig({})).toEqual({
      nodeEnv: 'development',
      host: '0.0.0.0',
      port: 3000,
      logLevel: 'info',
      allowedHosts: [],
      maxSourceBytes: 15 * MB,
      fetchTimeoutMs: 10_000,
      maxRedirects: 3,
      maxInputPixels: 40_000_000,
      processingTimeoutSeconds: 10,
      processingConcurrency: 4,
      processingQueueSize: 20,
      cacheMaxBytes: 128 * MB,
      cacheTtlSeconds: 3600,
      rateLimitPerMinute: 60,
      trustProxy: false,
      staticDir: undefined,
    });
  });

  it('reads values from the environment', () => {
    expect(
      loadConfig({
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '8080',
        LOG_LEVEL: 'warn',
        MAX_SOURCE_BYTES: '1000',
        FETCH_TIMEOUT_MS: '2500',
        MAX_REDIRECTS: '0',
        MAX_INPUT_PIXELS: '1000000',
        PROCESSING_TIMEOUT_SECONDS: '5',
        PROCESSING_CONCURRENCY: '2',
        PROCESSING_QUEUE_SIZE: '0',
        CACHE_MAX_BYTES: '0',
        CACHE_TTL_SECONDS: '60',
      }),
    ).toMatchObject({
      nodeEnv: 'production',
      host: '127.0.0.1',
      port: 8080,
      logLevel: 'warn',
      maxSourceBytes: 1000,
      fetchTimeoutMs: 2500,
      maxRedirects: 0,
      maxInputPixels: 1_000_000,
      processingTimeoutSeconds: 5,
      processingConcurrency: 2,
      processingQueueSize: 0,
      cacheMaxBytes: 0,
      cacheTtlSeconds: 60,
    });
  });

  it('treats empty strings as unset', () => {
    expect(loadConfig({ PORT: '', LOG_LEVEL: '' }).port).toBe(3000);
  });

  it.each(['abc', '0', '70000', '80.5'])('rejects PORT=%s naming the variable', (port) => {
    expect(() => loadConfig({ PORT: port })).toThrow(/PORT/);
  });

  it.each([
    ['MAX_SOURCE_BYTES', '0'],
    ['FETCH_TIMEOUT_MS', '50'],
    ['MAX_REDIRECTS', '11'],
    ['MAX_INPUT_PIXELS', '-1'],
    ['PROCESSING_TIMEOUT_SECONDS', '0'],
    ['PROCESSING_CONCURRENCY', '0'],
    ['PROCESSING_QUEUE_SIZE', '1.5'],
    ['CACHE_TTL_SECONDS', 'forever'],
  ])('rejects out-of-range %s=%s', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(new RegExp(name));
  });

  it('rejects an unknown LOG_LEVEL and lists valid ones', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL.*info/);
  });

  it('reports every invalid variable at once', () => {
    try {
      loadConfig({ PORT: 'abc', LOG_LEVEL: 'loud', NODE_ENV: 'staging' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const { issues } = error as ConfigError;
      expect(issues.map((issue) => issue.split(':')[0])).toEqual(['NODE_ENV', 'PORT', 'LOG_LEVEL']);
    }
  });

  it('parses ALLOWED_HOSTS as a trimmed, lower-cased list', () => {
    expect(
      loadConfig({ ALLOWED_HOSTS: ' Images.Example.com, *.cdn.example.net ,' }).allowedHosts,
    ).toEqual(['images.example.com', '*.cdn.example.net']);
  });

  it.each([
    'http://example.com',
    'example.com/path',
    '*example.com',
    'a.*.example.com',
    'exa mple.com',
  ])('rejects malformed ALLOWED_HOSTS entry %j', (entry) => {
    expect(() => loadConfig({ ALLOWED_HOSTS: entry })).toThrow(/ALLOWED_HOSTS/);
  });

  it('reads RATE_LIMIT_PER_MINUTE (0 disables)', () => {
    expect(loadConfig({ RATE_LIMIT_PER_MINUTE: '0' }).rateLimitPerMinute).toBe(0);
    expect(loadConfig({ RATE_LIMIT_PER_MINUTE: '600' }).rateLimitPerMinute).toBe(600);
  });

  it.each([
    ['false', false],
    ['1', 1],
    ['2', 2],
    ['loopback', ['loopback']],
    ['10.0.0.0/8, 192.168.1.10 ,uniquelocal', ['10.0.0.0/8', '192.168.1.10', 'uniquelocal']],
    ['fd00::/8', ['fd00::/8']],
  ] as const)('parses TRUST_PROXY=%j', (value, expected) => {
    expect(loadConfig({ TRUST_PROXY: value }).trustProxy).toEqual(expected);
  });

  it('refuses TRUST_PROXY=true because it lets any client spoof its IP', () => {
    expect(() => loadConfig({ TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY.*hops/);
  });

  it.each(['10.0.0.0/33', 'proxy.internal', '999.1.1.1'])(
    'rejects malformed TRUST_PROXY entry %j',
    (value) => {
      expect(() => loadConfig({ TRUST_PROXY: value })).toThrow(/TRUST_PROXY/);
    },
  );

  it('reads STATIC_DIR', () => {
    expect(loadConfig({ STATIC_DIR: '/srv/web' }).staticDir).toBe('/srv/web');
  });
});
