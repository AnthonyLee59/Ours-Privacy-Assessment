import { MIME_TYPES, parseProcessParams } from '@image-service/contract';
import type { FieldError, OutputFormat } from '@image-service/contract';
import { Router } from 'express';
import type { Request } from 'express';
import { ApiError } from '../http/api-error.js';
import { methodNotAllowed } from '../http/error-handler.js';
import type { ProcessService } from '../process/service.js';

/** `/process` is kept so the request examples from the brief work verbatim. */
export const PROCESS_PATHS = ['/v1/process', '/process'];

/** Browser/CDN cache lifetime. Sources can change, so not `immutable`. */
const CACHE_CONTROL = 'public, max-age=86400';

const EXTENSIONS: Record<OutputFormat, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
  gif: 'gif',
};

/** Raw query string, parsed ourselves so duplicates and unknown keys are visible to validation. */
function searchParams(req: Request): URLSearchParams {
  const index = req.originalUrl.indexOf('?');
  return new URLSearchParams(index === -1 ? '' : req.originalUrl.slice(index + 1));
}

function invalidParameters(errors: FieldError[]): ApiError {
  const detail =
    errors.length === 1
      ? errors[0]!.message
      : `${errors.length} parameters are invalid: ${errors.map((e) => e.param).join(', ')}. See "errors" for details.`;
  return new ApiError('INVALID_PARAMETER', detail, { errors });
}

/** "https://x/images/My%20Holiday.png" + webp -> "My_Holiday.webp"; safe for a quoted header value. */
export function downloadName(sourceUrl: string, format: OutputFormat): string {
  const segment = new URL(sourceUrl).pathname.split('/').pop() ?? '';
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Malformed escapes: keep the raw segment; sanitising below makes it safe.
  }
  const stem = decoded
    .replace(/\.[^.]*$/, '')
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 64);
  return `${stem || 'image'}.${EXTENSIONS[format]}`;
}

export function processRouter(service: ProcessService): Router {
  const router = Router();

  router.get(PROCESS_PATHS, async (req, res) => {
    const parsed = parseProcessParams(searchParams(req));
    if (!parsed.ok) throw invalidParameters(parsed.errors);

    const { image, cache } = await service.process(parsed.value);
    res.set({
      'Cache-Control': CACHE_CONTROL,
      ETag: image.etag,
      'X-Cache': cache,
      'X-Source-Width': String(image.source.width),
      'X-Source-Height': String(image.source.height),
      'X-Source-Format': image.source.format,
      'X-Source-Bytes': String(image.source.bytes),
      'X-Output-Width': String(image.width),
      'X-Output-Height': String(image.height),
      'Content-Disposition': `inline; filename="${downloadName(parsed.value.url, image.format)}"`,
    });
    // res.send answers 304 itself when If-None-Match matches the ETag set above.
    res.type(MIME_TYPES[image.format]).send(image.bytes);
  });
  router.all(PROCESS_PATHS, methodNotAllowed(['GET', 'HEAD']));

  return router;
}
