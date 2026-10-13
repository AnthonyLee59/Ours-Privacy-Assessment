import { describe, expect, it } from 'vitest';
import { planOutputSize } from '../../src/image/plan.js';

const landscape = { width: 400, height: 200 };

describe('planOutputSize', () => {
  it('keeps source size when no dimensions are requested', () => {
    expect(planOutputSize(landscape, { crop: 'fit' })).toEqual(landscape);
  });

  it.each([
    ['fill', { width: 100, height: 100 }],
    ['pad', { width: 100, height: 100 }],
    ['scale', { width: 100, height: 100 }],
    ['fit', { width: 100, height: 50 }],
    ['limit', { width: 100, height: 50 }],
  ] as const)('crop=%s into 100x100 gives %o', (crop, expected) => {
    expect(planOutputSize(landscape, { width: 100, height: 100, crop })).toEqual(expected);
  });

  it('fit upscales to fill the box', () => {
    expect(planOutputSize(landscape, { width: 800, height: 800, crop: 'fit' })).toEqual({
      width: 800,
      height: 400,
    });
  });

  it('limit never upscales', () => {
    expect(planOutputSize(landscape, { width: 800, height: 800, crop: 'limit' })).toEqual(
      landscape,
    );
  });

  it('scales proportionally with only width', () => {
    expect(planOutputSize(landscape, { width: 100, crop: 'fit' })).toEqual({
      width: 100,
      height: 50,
    });
  });

  it('scales proportionally with only height', () => {
    expect(planOutputSize(landscape, { height: 50, crop: 'fit' })).toEqual({
      width: 100,
      height: 50,
    });
  });

  it('limit with a single larger dimension keeps source size', () => {
    expect(planOutputSize(landscape, { width: 1000, crop: 'limit' })).toEqual(landscape);
  });

  it('never rounds a side down to zero', () => {
    expect(planOutputSize({ width: 1000, height: 1 }, { width: 10, crop: 'fit' })).toEqual({
      width: 10,
      height: 1,
    });
  });

  it('reports the extreme side a tall image would produce', () => {
    expect(planOutputSize({ width: 10, height: 1000 }, { width: 4000, crop: 'fit' })).toEqual({
      width: 4000,
      height: 400000,
    });
  });
});
