import { crc32 } from 'node:zlib';
import sharp from 'sharp';

type Rgba = { r: number; g: number; b: number; alpha?: number };

export const RED: Rgba = { r: 255, g: 0, b: 0 };
export const GREEN: Rgba = { r: 0, g: 255, b: 0 };
export const BLUE: Rgba = { r: 0, g: 0, b: 255 };

export function solid(width: number, height: number, background: Rgba = RED) {
  return sharp({ create: { width, height, channels: 3, background } });
}

export const png = (width: number, height: number, color?: Rgba) =>
  solid(width, height, color).png().toBuffer();

export const jpeg = (width: number, height: number) => solid(width, height).jpeg().toBuffer();

export const transparentPng = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .png()
    .toBuffer();

/**
 * 400x200, a 60px green strip on the left, rest red. `fill` to 100x100 crops
 * source columns 100-300 (strip gone); `scale` keeps the strip at x=0.
 */
export async function greenLeftStrip(): Promise<Buffer> {
  const green = await png(60, 200, GREEN);
  return solid(400, 200, RED)
    .composite([{ input: green, left: 0, top: 0 }])
    .png()
    .toBuffer();
}

/** Photo-like noise so lossy quality settings measurably change output size. */
export const noisyJpeg = (width: number, height: number) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: RED,
      noise: { type: 'gaussian', mean: 128, sigma: 60 },
    },
  })
    .jpeg({ quality: 95 })
    .toBuffer();

/** 200x100 pixels stored landscape, EXIF orientation 6 = display rotated 90°. */
export const rotatedJpeg = () => solid(200, 100).jpeg().withMetadata({ orientation: 6 }).toBuffer();

export const jpegWithExif = () =>
  solid(50, 50)
    .jpeg()
    .withExif({ IFD0: { Artist: 'Jane Photographer', Copyright: 'private-owner' } })
    .toBuffer();

export async function animatedGif(): Promise<Buffer> {
  const frames = await Promise.all([png(20, 20, RED), png(20, 20, BLUE)]);
  return sharp(frames, { join: { animated: true } })
    .gif()
    .toBuffer();
}

/** A tiny PNG whose header claims enormous dimensions (decompression bomb shape). */
export function pngHeaderClaiming(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ISO-BMFF `ftyp` box with the given major and compatible brands (AVIF/HEIC containers). */
export function ftyp(major: string, compatible: string[]): Buffer {
  const brands = [major, '\0\0\0\0', ...compatible].join('');
  const size = Buffer.alloc(4);
  size.writeUInt32BE(8 + brands.length);
  return Buffer.concat([size, Buffer.from(`ftyp${brands}`, 'latin1'), Buffer.alloc(64)]);
}

export async function pixel(image: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return [...data.subarray(offset, offset + info.channels)];
}
