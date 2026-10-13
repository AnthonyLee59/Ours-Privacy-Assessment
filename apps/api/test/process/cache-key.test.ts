import type { ProcessParams } from '@image-service/contract';
import { describe, expect, it } from 'vitest';
import { cacheKey } from '../../src/process/cache-key.js';

const base: ProcessParams = { url: 'https://example.com/a.png', width: 100, crop: 'fit' };
const key = (params: ProcessParams) => cacheKey(params, new URL(params.url));

describe('cacheKey', () => {
  it('is stable for identical requests', () => {
    expect(key(base)).toBe(key({ ...base }));
  });

  it('ignores property order', () => {
    expect(key({ crop: 'fit', width: 100, url: base.url })).toBe(key(base));
  });

  it('treats equivalent URL spellings as the same source', () => {
    expect(cacheKey(base, new URL('HTTPS://EXAMPLE.com:443/a.png'))).toBe(key(base));
  });

  it.each([
    ['url', { url: 'https://example.com/b.png' }],
    ['width', { width: 101 }],
    ['height', { height: 50 }],
    ['format', { format: 'webp' as const }],
    ['quality', { quality: 50 }],
    ['crop', { crop: 'fill' as const }],
  ])('changes when %s changes', (_name, change) => {
    expect(key({ ...base, ...change })).not.toBe(key(base));
  });

  it('is a fixed-length hash so long URLs do not bloat memory', () => {
    const long = { ...base, url: `https://example.com/${'a'.repeat(2000)}` };
    expect(key(long)).toMatch(/^[0-9a-f]{64}$/);
  });
});
