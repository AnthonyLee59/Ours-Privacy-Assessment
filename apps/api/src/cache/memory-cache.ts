import { LRUCache } from 'lru-cache';
import type { ProcessedImage } from '../image/pipeline.js';

export interface CachedImage extends ProcessedImage {
  /** Strong validator for the output bytes, quoted per RFC 9110. */
  etag: string;
}

/**
 * Processed-result cache. Async so an out-of-process store (Redis, a CDN
 * origin cache) can replace the in-memory one without touching callers.
 */
export interface ResultCache {
  get(key: string): Promise<CachedImage | undefined>;
  set(key: string, value: CachedImage): Promise<void>;
}

export interface ResultCacheOptions {
  /** Total byte budget for cached image bytes. 0 disables caching. */
  maxBytes: number;
  ttlMs: number;
  /** Clock override for tests. */
  now?: () => number;
}

/** A single result may use at most this share of the budget, so one huge image cannot flush the rest. */
const MAX_ENTRY_SHARE = 8;

export function createResultCache({ maxBytes, ttlMs, now }: ResultCacheOptions): ResultCache {
  if (maxBytes === 0) {
    return { get: () => Promise.resolve(undefined), set: () => Promise.resolve() };
  }
  const lru = new LRUCache<string, CachedImage>({
    maxSize: maxBytes,
    maxEntrySize: Math.floor(maxBytes / MAX_ENTRY_SHARE),
    sizeCalculation: (value) => Math.max(1, value.bytes.length),
    ttl: ttlMs,
    // An injected clock must be read on every check, not cached per real millisecond.
    ...(now && { perf: { now }, ttlResolution: 0 }),
  });
  return {
    get: (key) => Promise.resolve(lru.get(key)),
    set: (key, value) => {
      lru.set(key, value);
      return Promise.resolve();
    },
  };
}
