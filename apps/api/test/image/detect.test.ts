import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/http/api-error.js';
import { sniffFormat } from '../../src/image/detect.js';
import { ftyp, png, solid } from './fixtures.js';

function rejection(bytes: Buffer): ApiError {
  try {
    sniffFormat(bytes);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('UNSUPPORTED_MEDIA_TYPE');
    return error as ApiError;
  }
  throw new Error('expected rejection');
}

describe('sniffFormat — supported formats by magic bytes', () => {
  it.each([
    ['jpeg', () => solid(4, 4).jpeg().toBuffer()],
    ['png', () => png(4, 4)],
    ['webp', () => solid(4, 4).webp().toBuffer()],
    ['gif', () => solid(4, 4).gif().toBuffer()],
    ['tiff', () => solid(4, 4).tiff().toBuffer()],
    ['avif', () => solid(4, 4).avif().toBuffer()],
  ] as const)('detects %s', async (format, make) => {
    expect(sniffFormat(await make())).toBe(format);
  });

  it('detects big-endian TIFF', () => {
    expect(sniffFormat(Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]))).toBe('tiff');
  });

  it('detects AVIF by compatible brand', () => {
    expect(sniffFormat(ftyp('mif1', ['avif', 'miaf']))).toBe('avif');
  });

  it('ignores what the file claims to be by extension or header (bytes only)', async () => {
    // A PNG served as image/jpeg is still a PNG.
    expect(sniffFormat(await png(4, 4))).toBe('png');
  });
});

describe('sniffFormat — rejected inputs explain what to fix', () => {
  it('rejects an empty body', () => {
    expect(rejection(Buffer.alloc(0)).detail).toMatch(/empty/);
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
    '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>',
    '\uFEFF  <svg/>',
  ])('rejects SVG %#', (svg) => {
    expect(rejection(Buffer.from(svg)).detail).toMatch(/SVG/);
  });

  it.each([
    '<!doctype html><html><body>404</body></html>',
    '<html><head>',
    '<?xml version="1.0"?><rss/>',
  ])('rejects HTML/XML pages with a hint to link the image directly %#', (markup) => {
    expect(rejection(Buffer.from(markup)).detail).toMatch(/HTML or XML.*directly/);
  });

  it('rejects PDF', () => {
    expect(rejection(Buffer.from('%PDF-1.7\n...')).detail).toMatch(/PDF/);
  });

  it.each([
    ['heic', ['mif1', 'heic']],
    ['mif1', ['mif1', 'heix']],
  ] as const)('rejects HEIC/HEIF (%s) as unsupported', (major, brands) => {
    expect(rejection(ftyp(major, [...brands])).detail).toMatch(/HEIC/);
  });

  it.each([
    ['random bytes', Buffer.from('definitely not an image at all')],
    ['bmp', Buffer.from('BM\x00\x00\x00\x00\x00\x00\x00\x00')],
    ['mp4', ftyp('isom', ['iso2', 'mp41'])],
    ['truncated png signature', Buffer.from([0x89, 0x50, 0x4e])],
  ])('rejects %s and lists supported formats', (_label, bytes) => {
    expect(rejection(bytes).detail).toMatch(/jpeg, png, webp, avif, gif, tiff/);
  });

  it('never hands markup to the image decoder', async () => {
    // Sanity check of the threat: sharp itself would happily parse this SVG.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="5" height="5"/>');
    expect((await sharp(svg).metadata()).format).toBe('svg');
    expect(() => sniffFormat(svg)).toThrow(ApiError);
  });
});
