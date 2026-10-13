import { LIMITS, LOSSY_FORMATS } from '@image-service/contract';
import type { CropMode, InputFormat, OutputFormat, ProcessParams } from '@image-service/contract';
import sharp from 'sharp';
import type { FitEnum, ResizeOptions, Sharp } from 'sharp';
import { ApiError } from '../http/api-error.js';
import { sniffFormat } from './detect.js';
import { planOutputSize } from './plan.js';
import type { Size } from './plan.js';

export type TransformOptions = Omit<ProcessParams, 'url'>;

export interface ImageLimits {
  /** Decoded pixel budget (width x height); guards against decompression bombs. */
  maxInputPixels: number;
  /** Wall-clock limit for a single libvips pipeline. */
  timeoutSeconds: number;
}

export interface ProcessedImage {
  bytes: Buffer;
  format: OutputFormat;
  width: number;
  height: number;
  source: { format: InputFormat; width: number; height: number; bytes: number };
}

const CROP_TO_SHARP: Record<CropMode, { fit: keyof FitEnum; withoutEnlargement?: boolean }> = {
  fill: { fit: 'cover' },
  fit: { fit: 'inside' },
  limit: { fit: 'inside', withoutEnlargement: true },
  pad: { fit: 'contain' },
  scale: { fit: 'fill' },
};

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

/** TIFF is accepted as input but not offered as output; it becomes lossless PNG. */
function defaultOutputFormat(source: InputFormat): OutputFormat {
  return source === 'tiff' ? 'png' : source;
}

function corrupt(cause: unknown): ApiError {
  return new ApiError(
    'PROCESSING_FAILED',
    'The source image appears to be corrupt or truncated and could not be decoded.',
    { cause },
  );
}

function tooLarge(size: Size, maxPixels: number): ApiError {
  const megapixels = (size.width * size.height) / 1e6;
  return new ApiError(
    'IMAGE_TOO_LARGE',
    `The source image is ${size.width}x${size.height} (${megapixels.toFixed(1)} MP); the limit is ${maxPixels / 1e6} MP.`,
  );
}

/** Upright source dimensions from the header only (no pixel decoding). */
async function readSourceSize(input: Buffer): Promise<Size> {
  let meta;
  try {
    meta = await sharp(input, { limitInputPixels: false }).metadata();
  } catch (error) {
    throw corrupt(error);
  }
  const width = meta.autoOrient.width;
  const height = meta.autoOrient.height;
  if (!width || !height) throw corrupt(new Error('missing dimensions'));
  return { width, height };
}

function encode(pipeline: Sharp, format: OutputFormat, quality: number | undefined): Sharp {
  const q = quality ?? LIMITS.defaultQuality;
  switch (format) {
    case 'jpeg':
      // JPEG has no alpha; without this transparent areas turn black.
      return pipeline.flatten({ background: WHITE }).jpeg({ quality: q, progressive: true });
    case 'webp':
      return pipeline.webp({ quality: q });
    case 'avif':
      return pipeline.avif({ quality: q });
    case 'png':
      return pipeline.png();
    case 'gif':
      return pipeline.gif();
  }
}

/**
 * Validate, transform and re-encode an image.
 *
 * Order matters: format sniffing and the pixel budget are checked from bytes
 * and headers before libvips decodes anything. Output is auto-oriented and
 * has all metadata (EXIF, GPS, ICC comments) stripped, which sharp does by default.
 */
export async function processImage(
  input: Buffer,
  options: TransformOptions,
  limits: ImageLimits,
): Promise<ProcessedImage> {
  const sourceFormat = sniffFormat(input);
  const source = await readSourceSize(input);
  if (source.width * source.height > limits.maxInputPixels) {
    throw tooLarge(source, limits.maxInputPixels);
  }

  const resizing = options.width !== undefined || options.height !== undefined;
  const planned = planOutputSize(source, options);
  if (resizing && (planned.width > LIMITS.maxDimension || planned.height > LIMITS.maxDimension)) {
    const param = options.width !== undefined ? 'width' : 'height';
    const message = `This resize would produce a ${planned.width}x${planned.height} image; each side must be at most ${LIMITS.maxDimension}px. Request a smaller ${param} or use crop=fill.`;
    throw new ApiError('INVALID_PARAMETER', message, { errors: [{ param, message }] });
  }

  const format = options.format ?? defaultOutputFormat(sourceFormat);
  const quality = (LOSSY_FORMATS as readonly string[]).includes(format)
    ? options.quality
    : undefined;

  // Only the first frame of animated inputs is read (sharp's default `pages: 1`).
  let pipeline = sharp(input, { limitInputPixels: limits.maxInputPixels }).rotate();
  if (resizing) {
    const resize: ResizeOptions = {
      ...CROP_TO_SHARP[options.crop],
      background: format === 'jpeg' ? WHITE : TRANSPARENT,
    };
    if (options.width !== undefined) resize.width = options.width;
    if (options.height !== undefined) resize.height = options.height;
    pipeline = pipeline.resize(resize);
  }
  pipeline = encode(pipeline, format, quality).timeout({ seconds: limits.timeoutSeconds });

  let output;
  try {
    output = await pipeline.toBuffer({ resolveWithObject: true });
  } catch (error) {
    if (error instanceof Error && /timeout/i.test(error.message)) {
      throw new ApiError(
        'PROCESSING_FAILED',
        `Processing took longer than ${limits.timeoutSeconds}s. Try a smaller source image or output size.`,
        { cause: error },
      );
    }
    throw corrupt(error);
  }

  return {
    bytes: output.data,
    format,
    width: output.info.width,
    height: output.info.height,
    source: { format: sourceFormat, ...source, bytes: input.length },
  };
}
