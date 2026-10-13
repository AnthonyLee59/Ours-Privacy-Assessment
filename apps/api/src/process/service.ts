import { createHash } from 'node:crypto';
import type { ProcessParams } from '@image-service/contract';
import type { CachedImage, ResultCache } from '../cache/memory-cache.js';
import type { Fetcher } from '../fetch/fetcher.js';
import { processImage } from '../image/pipeline.js';
import type { ImageLimits } from '../image/pipeline.js';
import { assertAllowedSourceUrl } from '../security/url-policy.js';
import type { UrlPolicy } from '../security/url-policy.js';
import { cacheKey } from './cache-key.js';
import type { Limiter } from './limiter.js';

export interface ProcessServiceDeps {
  fetcher: Fetcher;
  cache: ResultCache;
  limiter: Limiter;
  imageLimits: ImageLimits;
  urlPolicy: UrlPolicy;
}

export interface ProcessOutcome {
  image: CachedImage;
  cache: 'HIT' | 'MISS';
}

export interface ProcessService {
  process(params: ProcessParams): Promise<ProcessOutcome>;
}

function strongEtag(bytes: Buffer): string {
  return `"${createHash('sha256').update(bytes).digest('base64url')}"`;
}

/**
 * Cache-first orchestration of fetch + transform.
 *
 * Concurrent identical requests share one in-flight job (single-flight), so a
 * burst for the same image costs one fetch and one encode. The shared job is
 * deliberately not tied to any one caller's connection: if the first caller
 * disconnects, the others still get their result, and the cache is warmed.
 * Failures are never cached.
 */
export function createProcessService(deps: ProcessServiceDeps): ProcessService {
  const inFlight = new Map<string, Promise<CachedImage>>();

  async function produce(params: ProcessParams, sourceUrl: URL): Promise<CachedImage> {
    return deps.limiter.run(async () => {
      const { bytes } = await deps.fetcher.fetch(sourceUrl);
      const result = await processImage(bytes, params, deps.imageLimits);
      return { ...result, etag: strongEtag(result.bytes) };
    });
  }

  return {
    async process(params) {
      // Static policy first: cheap, and keeps disallowed URLs out of cache keys entirely.
      const sourceUrl = assertAllowedSourceUrl(params.url, deps.urlPolicy);
      const key = cacheKey(params, sourceUrl);

      const cached = await deps.cache.get(key);
      if (cached) return { image: cached, cache: 'HIT' };

      let job = inFlight.get(key);
      if (!job) {
        job = produce(params, sourceUrl).then(async (image) => {
          await deps.cache.set(key, image);
          return image;
        });
        inFlight.set(key, job);
        void job.then(
          () => inFlight.delete(key),
          () => inFlight.delete(key),
        );
      }
      return { image: await job, cache: 'MISS' };
    },
  };
}
