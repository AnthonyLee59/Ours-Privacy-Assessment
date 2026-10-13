import { createHash } from 'node:crypto';
import type { ProcessParams } from '@image-service/contract';

/**
 * Deterministic key for a transformation: the normalised source URL plus every
 * parameter in a fixed order. Hashed so 2 KB URLs cost 64 bytes of key.
 */
export function cacheKey(params: ProcessParams, sourceUrl: URL): string {
  const canonical = JSON.stringify([
    sourceUrl.href,
    params.width ?? null,
    params.height ?? null,
    params.format ?? null,
    params.quality ?? null,
    params.crop,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
