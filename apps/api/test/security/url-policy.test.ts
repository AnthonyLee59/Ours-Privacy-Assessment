import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/http/api-error.js';
import { assertAllowedSourceUrl } from '../../src/security/url-policy.js';
import type { UrlPolicy } from '../../src/security/url-policy.js';

const open: UrlPolicy = { allowedHosts: [] };

function rejection(url: string, policy = open): ApiError {
  try {
    assertAllowedSourceUrl(url, policy);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('URL_NOT_ALLOWED');
    return error as ApiError;
  }
  throw new Error(`expected ${url} to be rejected`);
}

describe('assertAllowedSourceUrl — accepted', () => {
  it.each([
    'https://example.com/image.jpg',
    'http://example.com/image.jpg',
    'https://example.com:443/a.png',
    'http://example.com:80/a.png',
    'https://cdn.example.co.uk/path/to/a.png?size=large#frag',
    'https://93.184.216.34/a.png',
    'https://[2606:4700::1111]/a.png',
  ])('%s', (url) => {
    expect(assertAllowedSourceUrl(url, open)).toBeInstanceOf(URL);
  });

  it('returns the normalised URL', () => {
    expect(assertAllowedSourceUrl('HTTPS://Example.COM:443/a.png', open).href).toBe(
      'https://example.com/a.png',
    );
  });

  it('accepts URL objects (used when following redirects)', () => {
    expect(assertAllowedSourceUrl(new URL('https://example.com/a'), open).hostname).toBe(
      'example.com',
    );
  });
});

describe('assertAllowedSourceUrl — scheme, credentials, port', () => {
  it.each(['ftp://example.com/a.png', 'file:///etc/passwd', 'gopher://example.com/', 'data:,x'])(
    'rejects scheme of %s',
    (url) => {
      expect(rejection(url).detail).toMatch(/http and https/);
    },
  );

  it('rejects unparseable input', () => {
    expect(rejection('not a url').detail).toMatch(/not a valid URL/);
  });

  it.each(['https://user:pass@example.com/a.png', 'https://user@example.com/a.png'])(
    'rejects embedded credentials in %s',
    (url) => {
      expect(rejection(url).detail).toMatch(/credentials/);
    },
  );

  it.each([
    'https://example.com:8080/a.png',
    'http://example.com:22/',
    'https://example.com:6379/',
  ])('rejects non-default port in %s', (url) => {
    expect(rejection(url).detail).toMatch(/ports 80 and 443/);
  });
});

describe('assertAllowedSourceUrl — allowedPorts override', () => {
  const policy: UrlPolicy = { allowedHosts: [], allowedPorts: ['8443'] };

  it('accepts a port the policy lists', () => {
    expect(assertAllowedSourceUrl('https://example.com:8443/a.png', policy).port).toBe('8443');
  });

  it('still accepts default ports', () => {
    expect(assertAllowedSourceUrl('https://example.com/a.png', policy)).toBeInstanceOf(URL);
  });

  it('rejects ports the policy does not list', () => {
    expect(rejection('https://example.com:8080/a.png', policy).detail).toMatch(/8443/);
  });
});

describe('assertAllowedSourceUrl — IP literals (SSRF)', () => {
  it.each([
    ['http://127.0.0.1/', 'loopback'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://10.1.2.3/', 'private'],
    ['http://0.0.0.0/', 'unspecified'],
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped loopback'],
    ['http://[::ffff:7f00:1]/', 'IPv4-mapped loopback, hex form'],
    ['http://[fd00::1]/', 'IPv6 unique local'],
    // WHATWG URL parsing normalises these alternate IPv4 spellings to 127.0.0.1.
    ['http://2130706433/', 'decimal-encoded loopback'],
    ['http://0x7f.0.0.1/', 'hex-encoded loopback'],
    ['http://0177.0.0.1/', 'octal-encoded loopback'],
    ['http://127.1/', 'short-form loopback'],
    ['http://0x7f000001/', 'single hex integer loopback'],
  ])('rejects %s (%s)', (url) => {
    expect(rejection(url).detail).toMatch(/private, loopback or reserved/);
  });
});

describe('assertAllowedSourceUrl — internal hostnames', () => {
  it.each([
    'http://localhost/',
    'http://LOCALHOST/',
    'http://localhost./',
    'http://api.localhost/',
    'http://printer.local/',
    'http://metadata.google.internal/',
    'http://router.home.arpa/',
    'http://nas.lan/',
    'http://metadata/computeMetadata/v1/',
    'http://redis/',
    'http://ⓛocalhost/',
  ])('rejects %s', (url) => {
    expect(rejection(url).detail).toMatch(/internal or single-label/);
  });
});

describe('assertAllowedSourceUrl — ALLOWED_HOSTS', () => {
  const policy = { allowedHosts: ['images.example.com', '*.cdn.example.net'] };

  it.each([
    'https://images.example.com/a.png',
    'https://IMAGES.example.com./a.png',
    'https://eu.cdn.example.net/a.png',
    'https://a.b.cdn.example.net/a.png',
  ])('allows listed host %s', (url) => {
    expect(assertAllowedSourceUrl(url, policy)).toBeInstanceOf(URL);
  });

  it.each([
    'https://example.com/a.png',
    'https://evil-images.example.com/a.png',
    'https://cdn.example.net/a.png',
    'https://cdn.example.net.evil.com/a.png',
  ])('rejects unlisted host %s', (url) => {
    expect(rejection(url, policy).detail).toMatch(/not in the list of allowed hosts/);
  });

  it('still blocks internal IPs even if someone lists them', () => {
    expect(rejection('http://127.0.0.1/', { allowedHosts: ['127.0.0.1'] }).detail).toMatch(
      /private, loopback or reserved/,
    );
  });
});
