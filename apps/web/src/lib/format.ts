import type { CropMode, OutputFormat, TransformOptions } from '@image-service/sdk';

/** Raw form values; empty string means "not set, use the server default". */
export interface FormState {
  url: string;
  width: string;
  height: string;
  format: '' | OutputFormat;
  quality: string;
  crop: '' | CropMode;
}

export const EMPTY_FORM: FormState = {
  url: '',
  width: '',
  height: '',
  format: '',
  quality: '',
  crop: '',
};

export const LOSSLESS_FORMATS: readonly string[] = ['png', 'gif'];

/**
 * Form values to SDK options. Blank fields are omitted so server defaults apply;
 * values for disabled controls (crop without a size, quality for lossless formats)
 * are dropped so the request matches what the user sees.
 */
export function toOptions(form: FormState): TransformOptions {
  const options: TransformOptions = { url: form.url.trim() };
  if (form.width !== '') options.width = Number(form.width);
  if (form.height !== '') options.height = Number(form.height);
  if (form.format !== '') options.format = form.format;
  if (form.quality !== '' && !LOSSLESS_FORMATS.includes(form.format)) {
    options.quality = Number(form.quality);
  }
  if (form.crop !== '' && (form.width !== '' || form.height !== '')) options.crop = form.crop;
  return options;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Relative size change, e.g. "−62%" (true minus sign) or "+12%". */
export function sizeChange(before: number | undefined, after: number): string {
  if (!before) return '';
  const percent = Math.round(((after - before) / before) * 100);
  if (percent === 0) return '±0%';
  return percent < 0 ? `−${Math.abs(percent)}%` : `+${percent}%`;
}

/**
 * Shell-safe curl snippet. An explicit -o name (rather than -OJ) means re-running
 * it overwrites the file instead of failing with "File exists".
 */
export function curlCommand(url: string, filename: string): string {
  return `curl -fo ${filename} '${url.replaceAll("'", "'\\''")}'`;
}

export const EXTENSIONS: Record<OutputFormat, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
  gif: 'gif',
};

/**
 * Source file extensions mapped to the extension the API returns when no format is chosen.
 * A Map, not an object: keys come from user input ("x.constructor") and end up in a shell snippet.
 */
const SOURCE_EXTENSIONS = new Map([
  ['jpg', 'jpg'],
  ['jpeg', 'jpg'],
  ['png', 'png'],
  ['webp', 'webp'],
  ['avif', 'avif'],
  ['gif', 'gif'],
  ['tif', 'png'],
  ['tiff', 'png'],
]);

/** Local filename for saving the result: chosen format, else inferred from the source path. */
export function outputFilename(form: FormState): string {
  if (form.format !== '') return `processed.${EXTENSIONS[form.format]}`;
  let path: string;
  try {
    path = new URL(form.url.trim()).pathname;
  } catch {
    return 'processed';
  }
  const ext = SOURCE_EXTENSIONS.get(path.split('.').pop()?.toLowerCase() ?? '');
  return ext ? `processed.${ext}` : 'processed';
}
