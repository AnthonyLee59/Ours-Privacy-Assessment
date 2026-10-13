/** Formats the API can encode to. `jpg` is accepted as an alias of `jpeg`. */
export const OUTPUT_FORMATS = ['jpeg', 'png', 'webp', 'avif', 'gif'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const FORMAT_ALIASES: Readonly<Record<string, OutputFormat>> = { jpg: 'jpeg' };

/** Output formats where `quality` has an effect. */
export const LOSSY_FORMATS = ['jpeg', 'webp', 'avif'] as const satisfies readonly OutputFormat[];

/** Source formats the API accepts, detected from file bytes rather than Content-Type. */
export const INPUT_FORMATS = ['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff'] as const;
export type InputFormat = (typeof INPUT_FORMATS)[number];

export const MIME_TYPES: Readonly<Record<OutputFormat, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
};

/**
 * Cloudinary-style resize modes, applied when width and/or height are given.
 * - fill:  crop to exactly width x height, keeping aspect ratio (centre crop)
 * - fit:   fit inside width x height, keeping aspect ratio (may upscale)
 * - limit: like fit, but never upscales
 * - pad:   fit inside, then pad to exactly width x height
 * - scale: stretch to exactly width x height, ignoring aspect ratio
 */
export const CROP_MODES = ['fill', 'fit', 'limit', 'pad', 'scale'] as const;
export type CropMode = (typeof CROP_MODES)[number];

export const DEFAULT_CROP: CropMode = 'fit';

/** Crop modes that only make sense with an exact target box. */
export const CROP_MODES_NEEDING_BOTH_DIMENSIONS = [
  'fill',
  'pad',
  'scale',
] as const satisfies readonly CropMode[];

/** Public request limits. Server-side resource limits (source size, timeouts) live in API config. */
export const LIMITS = {
  maxDimension: 4000,
  maxUrlLength: 2048,
  minQuality: 1,
  maxQuality: 100,
  defaultQuality: 80,
} as const;

export const PARAM_NAMES = ['url', 'width', 'height', 'format', 'quality', 'crop'] as const;
export type ParamName = (typeof PARAM_NAMES)[number];
