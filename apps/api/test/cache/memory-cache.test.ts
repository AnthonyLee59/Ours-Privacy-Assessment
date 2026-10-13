import { describe, expect, it } from 'vitest';
import { createResultCache } from '../../src/cache/memory-cache.js';
import type { CachedImage } from '../../src/cache/memory-cache.js';

function entry(bytes: number, tag = 'x'): CachedImage {
  return {
    bytes: Buffer.alloc(bytes),
    format: 'png',
    width: 1,
    height: 1,
    etag: `"${tag}"`,
    source: { format: 'png', width: 1, height: 1, bytes: 10 },
  };
}

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('createResultCache', () => {
  it('returns what was stored', async () => {
    const cache = createResultCache({ maxBytes: 1000, ttlMs: 60_000 });
    await cache.set('a', entry(10, 'a'));
    expect((await cache.get('a'))?.etag).toBe('"a"');
    expect(await cache.get('missing')).toBeUndefined();
  });

  it('evicts least recently used entries to stay within the byte budget', async () => {
    const cache = createResultCache({ maxBytes: 800, ttlMs: 60_000 });
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) await cache.set(key, entry(100));
    await cache.get('a'); // a is now more recent than b
    await cache.set('i', entry(100));
    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('a')).toBeDefined();
    expect(await cache.get('i')).toBeDefined();
  });

  it('does not store a single entry larger than an eighth of the budget', async () => {
    // One huge image must not flush everything else out.
    const cache = createResultCache({ maxBytes: 800, ttlMs: 60_000 });
    await cache.set('small', entry(50));
    await cache.set('huge', entry(101));
    expect(await cache.get('huge')).toBeUndefined();
    expect(await cache.get('small')).toBeDefined();
  });

  it('expires entries after the TTL', async () => {
    const time = clock();
    const cache = createResultCache({ maxBytes: 1000, ttlMs: 1000, now: time.now });
    await cache.set('a', entry(10));
    time.advance(999);
    expect(await cache.get('a')).toBeDefined();
    time.advance(2);
    expect(await cache.get('a')).toBeUndefined();
  });

  it('is a no-op when the budget is zero (caching disabled)', async () => {
    const cache = createResultCache({ maxBytes: 0, ttlMs: 1000 });
    await cache.set('a', entry(10));
    expect(await cache.get('a')).toBeUndefined();
  });
});
