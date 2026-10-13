import { INPUT_FORMATS } from '@image-service/contract';
import type { InputFormat } from '@image-service/contract';
import { ApiError } from '../http/api-error.js';

const SUPPORTED = `Supported formats: ${INPUT_FORMATS.join(', ')}.`;

function unsupported(detail: string): never {
  throw new ApiError('UNSUPPORTED_MEDIA_TYPE', detail);
}

function startsWith(bytes: Buffer, signature: number[], offset = 0): boolean {
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

function ascii(bytes: Buffer, start: number, end: number): string {
  return bytes.subarray(start, end).toString('latin1');
}

/** Brands of an ISO-BMFF `ftyp` box (AVIF, HEIC, MP4 share this container), or undefined. */
function ftypBrands(bytes: Buffer): string[] | undefined {
  if (bytes.length < 16 || ascii(bytes, 4, 8) !== 'ftyp') return undefined;
  const boxEnd = Math.min(bytes.readUInt32BE(0), bytes.length);
  const brands = [ascii(bytes, 8, 12)];
  for (let offset = 16; offset + 4 <= boxEnd; offset += 4) {
    brands.push(ascii(bytes, offset, offset + 4));
  }
  return brands;
}

/** Leading `<` after optional BOM/whitespace (trimStart also strips U+FEFF). */
function looksLikeMarkup(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 512).toString('utf8').trimStart();
  return head.startsWith('<');
}

/**
 * Identify the source format from its leading bytes, ignoring Content-Type and
 * file extension (both are attacker-controlled). Only allow-listed formats get
 * past this point, so the decoder never sees SVG, PDF or other complex inputs.
 *
 * @throws ApiError UNSUPPORTED_MEDIA_TYPE with a reason the caller can act on.
 */
export function sniffFormat(bytes: Buffer): InputFormat {
  if (bytes.length === 0) unsupported('The source URL returned an empty file.');

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp';
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'tiff';
  }

  const brands = ftypBrands(bytes);
  if (brands?.some((brand) => brand === 'avif' || brand === 'avis')) return 'avif';
  if (brands?.some((brand) => ['heic', 'heix', 'hevc', 'heif', 'mif1', 'msf1'].includes(brand))) {
    unsupported(`HEIC/HEIF images are not supported. ${SUPPORTED}`);
  }

  if (looksLikeMarkup(bytes)) {
    if (/<svg[\s>/]/i.test(bytes.subarray(0, 4096).toString('utf8'))) {
      unsupported(`SVG images are not supported. ${SUPPORTED}`);
    }
    unsupported(
      'The source URL returned an HTML or XML document, not an image. Link directly to the image file.',
    );
  }
  if (ascii(bytes, 0, 5) === '%PDF-') unsupported(`PDF documents are not supported. ${SUPPORTED}`);

  unsupported(`The source file is not a supported image. ${SUPPORTED}`);
}
