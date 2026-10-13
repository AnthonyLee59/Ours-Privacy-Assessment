import type { CropMode, ImageApiErrorCode } from '@image-service/sdk';

export interface Sample {
  label: string;
  url: string;
  kind: 'image' | 'error';
}

export const SAMPLES: Sample[] = [
  { label: 'Dog photo', url: 'https://picsum.photos/id/237/1200/800.jpg', kind: 'image' },
  {
    label: 'Transparent PNG',
    url: 'https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png',
    kind: 'image',
  },
  { label: 'Landscape', url: 'https://picsum.photos/id/1018/2000/1200.jpg', kind: 'image' },
  {
    label: 'Blocked: cloud metadata',
    url: 'http://169.254.169.254/latest/meta-data/',
    kind: 'error',
  },
  { label: 'Not an image', url: 'https://example.com/', kind: 'error' },
];

export const CROP_HELP: Record<CropMode, string> = {
  fit: 'Fit inside the box, keep the aspect ratio (may upscale).',
  fill: 'Fill the box exactly, cropping the overflow from the centre.',
  limit: 'Like fit, but never upscale a smaller image.',
  pad: 'Fit inside, then pad to the exact box (transparent, or white for JPEG).',
  scale: 'Stretch to exactly the box, ignoring the aspect ratio.',
};

export const CROP_LABELS: Record<CropMode, string> = {
  fit: 'Fit',
  fill: 'Fill & crop',
  limit: 'Fit, no upscale',
  pad: 'Fit & pad',
  scale: 'Stretch',
};

/** Friendly headline per error code; the API's `detail` carries the specifics. */
export const ERROR_TITLES: Partial<Record<ImageApiErrorCode, string>> = {
  INVALID_PARAMETER: 'Check the highlighted fields',
  URL_NOT_ALLOWED: "This URL can't be fetched",
  SOURCE_FETCH_FAILED: "Couldn't download the image",
  SOURCE_TIMEOUT: 'The source took too long to respond',
  TOO_MANY_REDIRECTS: 'Too many redirects',
  SOURCE_TOO_LARGE: 'The file is too large',
  UNSUPPORTED_MEDIA_TYPE: 'Not a supported image',
  IMAGE_TOO_LARGE: 'Image dimensions are too large',
  PROCESSING_FAILED: "Couldn't process the image",
  RATE_LIMITED: 'Slow down a little',
  SERVER_BUSY: 'The server is busy',
  NETWORK_ERROR: "Can't reach the image API",
  UNEXPECTED_RESPONSE: 'Unexpected response from the API',
};
