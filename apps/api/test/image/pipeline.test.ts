import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/http/api-error.js';
import { processImage } from '../../src/image/pipeline.js';
import type { ImageLimits, TransformOptions } from '../../src/image/pipeline.js';
import {
  animatedGif,
  greenLeftStrip,
  jpeg,
  jpegWithExif,
  noisyJpeg,
  pixel,
  png,
  pngHeaderClaiming,
  rotatedJpeg,
  solid,
  transparentPng,
} from './fixtures.js';

const limits: ImageLimits = { maxInputPixels: 40_000_000, timeoutSeconds: 10 };

const run = (
  input: Buffer,
  options: Partial<TransformOptions> = {},
  overrides?: Partial<ImageLimits>,
) => processImage(input, { crop: 'fit', ...options }, { ...limits, ...overrides });

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => {
      throw new Error('expected processing to fail');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

async function dims(image: Buffer) {
  const { width, height, format } = await sharp(image).metadata();
  return { width, height, format };
}

describe('processImage — resize', () => {
  it('fits inside the box keeping aspect ratio by default (PDF example 500x300)', async () => {
    const out = await run(await png(1000, 1000), { width: 500, height: 300 });
    expect(await dims(out.bytes)).toMatchObject({ width: 300, height: 300 });
    expect(out).toMatchObject({ width: 300, height: 300 });
  });

  it.each([
    ['fill', 100, 100],
    ['pad', 100, 100],
    ['scale', 100, 100],
    ['fit', 100, 50],
    ['limit', 100, 50],
  ] as const)('crop=%s on 400x200 into 100x100 yields %ix%i', async (crop, width, height) => {
    const out = await run(await png(400, 200), { width: 100, height: 100, crop });
    expect(await dims(out.bytes)).toMatchObject({ width, height });
  });

  it('fill crops the centre (left strip cut away) while scale stretches (left strip kept)', async () => {
    const source = await greenLeftStrip();
    const filled = await run(source, { width: 100, height: 100, crop: 'fill' });
    const scaled = await run(source, { width: 100, height: 100, crop: 'scale' });
    expect((await pixel(filled.bytes, 0, 50)).slice(0, 3)).toEqual([255, 0, 0]);
    expect((await pixel(scaled.bytes, 0, 50)).slice(0, 3)).toEqual([0, 255, 0]);
  });

  it('pad fills with transparency for formats with alpha', async () => {
    const out = await run(await png(400, 200), { width: 100, height: 100, crop: 'pad' });
    expect((await pixel(out.bytes, 0, 0))[3]).toBe(0);
  });

  it('pad fills with white for jpeg', async () => {
    const out = await run(await png(400, 200), {
      width: 100,
      height: 100,
      crop: 'pad',
      format: 'jpeg',
    });
    const [r, g, b] = await pixel(out.bytes, 0, 0);
    expect(Math.min(r!, g!, b!)).toBeGreaterThan(245);
  });

  it('limit does not upscale; fit does', async () => {
    const small = await png(100, 50);
    expect(
      await dims((await run(small, { width: 400, height: 400, crop: 'limit' })).bytes),
    ).toMatchObject({ width: 100, height: 50 });
    expect(
      await dims((await run(small, { width: 400, height: 400, crop: 'fit' })).bytes),
    ).toMatchObject({
      width: 400,
      height: 200,
    });
  });

  it('scales proportionally from width alone', async () => {
    expect(await dims((await run(await png(400, 200), { width: 100 })).bytes)).toMatchObject({
      width: 100,
      height: 50,
    });
  });

  it('refuses a resize whose other side would explode past the output limit', async () => {
    const error = await failure(run(await png(10, 1000), { width: 4000 }));
    expect(error.code).toBe('INVALID_PARAMETER');
    expect(error.errors?.[0]?.param).toBe('width');
    expect(error.detail).toMatch(/4000x400000/);
  });

  it('returns the source unchanged in size when no dimensions are given', async () => {
    const out = await run(await png(123, 45));
    expect(out).toMatchObject({ width: 123, height: 45 });
  });
});

describe('processImage — format and quality', () => {
  it('converts png to jpeg (PDF example)', async () => {
    const out = await run(await png(50, 50), { format: 'jpeg', quality: 80 });
    expect(out.format).toBe('jpeg');
    expect((await dims(out.bytes)).format).toBe('jpeg');
  });

  it.each(['png', 'webp', 'avif', 'gif'] as const)('encodes %s', async (format) => {
    const out = await run(await png(20, 20), { format });
    const detected = (await sharp(out.bytes).metadata()).format;
    expect(detected).toBe(format === 'avif' ? 'heif' : format);
    expect(out.format).toBe(format);
  });

  it('combines resize and conversion (PDF example webp + fill)', async () => {
    const out = await run(await jpeg(1600, 1000), {
      width: 800,
      height: 600,
      format: 'webp',
      crop: 'fill',
    });
    expect(await dims(out.bytes)).toEqual({ width: 800, height: 600, format: 'webp' });
  });

  it('lower quality produces a smaller lossy file', async () => {
    const source = await noisyJpeg(200, 200);
    const low = await run(source, { format: 'jpeg', quality: 10 });
    const high = await run(source, { format: 'jpeg', quality: 95 });
    expect(low.bytes.length).toBeLessThan(high.bytes.length);
  });

  it.each([
    ['png', 'png'],
    ['jpeg', 'jpeg'],
    ['webp', 'webp'],
    ['gif', 'gif'],
    ['tiff', 'png'],
  ] as const)('defaults %s input to %s output', async (input, expected) => {
    const source = await solid(10, 10)[input]().toBuffer();
    expect((await run(source)).format).toBe(expected);
  });

  it('flattens transparency onto white when converting to jpeg (not black)', async () => {
    const out = await run(await transparentPng(10, 10), { format: 'jpeg' });
    const [r, g, b] = await pixel(out.bytes, 5, 5);
    expect(Math.min(r!, g!, b!)).toBeGreaterThan(245);
  });
});

describe('processImage — orientation, metadata, animation', () => {
  it('applies EXIF orientation so images display upright', async () => {
    const out = await run(await rotatedJpeg());
    expect(out).toMatchObject({ width: 100, height: 200 });
    expect(out.source).toMatchObject({ width: 100, height: 200 });
  });

  it('strips EXIF and other metadata (location, camera, author)', async () => {
    const source = await jpegWithExif();
    expect((await sharp(source).metadata()).exif).toBeDefined();
    const out = await run(source, { format: 'jpeg' });
    const meta = await sharp(out.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(out.bytes.includes('private-owner')).toBe(false);
  });

  it('uses only the first frame of animated GIFs', async () => {
    const out = await run(await animatedGif(), { format: 'png' });
    expect(await dims(out.bytes)).toMatchObject({ width: 20, height: 20 });
    expect((await pixel(out.bytes, 10, 10)).slice(0, 3)).toEqual([255, 0, 0]);
  });
});

describe('processImage — source details', () => {
  it('reports source format, dimensions and byte size', async () => {
    const source = await jpeg(300, 150);
    const out = await run(source, { width: 30, format: 'png' });
    expect(out.source).toEqual({ format: 'jpeg', width: 300, height: 150, bytes: source.length });
  });
});

describe('processImage — hostile and broken inputs', () => {
  it('rejects images over the pixel budget before decoding', async () => {
    const error = await failure(run(await png(200, 100), {}, { maxInputPixels: 10_000 }));
    expect(error.code).toBe('IMAGE_TOO_LARGE');
    expect(error.detail).toMatch(/200x100/);
  });

  it('rejects a decompression bomb from its header alone', async () => {
    const bomb = pngHeaderClaiming(100_000, 100_000);
    expect(bomb.length).toBeLessThan(100);
    const started = Date.now();
    const error = await failure(run(bomb));
    expect(error.code).toBe('IMAGE_TOO_LARGE');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('rejects non-images with 415', async () => {
    const error = await failure(run(Buffer.from('<html>nope</html>')));
    expect(error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('reports corrupt data behind a valid signature as unprocessable', async () => {
    const corrupt = Buffer.concat([
      (await png(10, 10)).subarray(0, 8),
      Buffer.from('garbage'.repeat(20)),
    ]);
    const error = await failure(run(corrupt));
    expect(error.code).toBe('PROCESSING_FAILED');
  });

  it('reports truncated images as unprocessable', async () => {
    const full = await noisyJpeg(200, 200);
    const error = await failure(run(full.subarray(0, Math.floor(full.length / 2)), { width: 50 }));
    expect(error.code).toBe('PROCESSING_FAILED');
    expect(error.detail).toMatch(/corrupt or truncated/);
  });
});
