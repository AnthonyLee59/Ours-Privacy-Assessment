import type { CropMode } from '@image-service/contract';

export interface Size {
  width: number;
  height: number;
}

export interface ResizeRequest {
  width?: number;
  height?: number;
  crop: CropMode;
}

/**
 * Output dimensions a resize will produce, computed from the source header
 * before any pixels are decoded. Used to refuse requests whose aspect ratio
 * would explode one side (e.g. width=4000 on a 10x1000 image).
 */
export function planOutputSize(source: Size, { width, height, crop }: ResizeRequest): Size {
  if (width === undefined && height === undefined) return source;

  if (width !== undefined && height !== undefined) {
    if (crop === 'fill' || crop === 'pad' || crop === 'scale') return { width, height };
  }

  let scale = Math.min(
    width === undefined ? Infinity : width / source.width,
    height === undefined ? Infinity : height / source.height,
  );
  if (crop === 'limit') scale = Math.min(scale, 1);

  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}
