import { describe, expect, it } from 'vitest';
import {
  EMPTY_FORM,
  curlCommand,
  formatBytes,
  outputFilename,
  sizeChange,
  toOptions,
} from '../src/lib/format';
import type { FormState } from '../src/lib/format';

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [999, '999 B'],
    [1024, '1.0 KB'],
    [54_321, '53.0 KB'],
    [15 * 1024 * 1024, '15.0 MB'],
  ])('%i -> %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe('sizeChange', () => {
  it.each([
    [1000, 380, '−62%'],
    [1000, 1120, '+12%'],
    [1000, 1000, '±0%'],
  ])('%i -> %i is %s', (before, after, text) => {
    expect(sizeChange(before, after)).toBe(text);
  });

  it('is empty when the original size is unknown', () => {
    expect(sizeChange(undefined, 10)).toBe('');
    expect(sizeChange(0, 10)).toBe('');
  });
});

describe('curlCommand', () => {
  it('saves to an explicit file (re-running overwrites it) and fails on HTTP errors', () => {
    expect(curlCommand('https://img.test/v1/process?url=x&width=10', 'processed.webp')).toBe(
      "curl -fo processed.webp 'https://img.test/v1/process?url=x&width=10'",
    );
  });

  it('escapes single quotes so the snippet is always safe to paste', () => {
    expect(curlCommand("https://img.test/v1/process?url=it's", 'processed.png')).toBe(
      "curl -fo processed.png 'https://img.test/v1/process?url=it'\\''s'",
    );
  });
});

describe('outputFilename', () => {
  it.each([
    [{ format: 'webp', url: 'https://a.test/cat.png' }, 'processed.webp'],
    [{ format: 'jpeg', url: 'https://a.test/cat.png' }, 'processed.jpg'],
    [{ format: '', url: 'https://a.test/cat.PNG' }, 'processed.png'],
    [{ format: '', url: 'https://a.test/photo.jpeg?v=2' }, 'processed.jpg'],
    [{ format: '', url: 'https://a.test/scan.tiff' }, 'processed.png'],
    [{ format: '', url: 'https://a.test/image' }, 'processed'],
    [{ format: '', url: 'https://a.test/archive.zip' }, 'processed'],
    [{ format: '', url: 'not a url' }, 'processed'],
    [{ format: '', url: 'https://a.test/x.constructor' }, 'processed'],
    [{ format: '', url: 'https://a.test/x.__proto__' }, 'processed'],
  ] as const)('%o -> %s', (form, name) => {
    expect(outputFilename({ ...EMPTY_FORM, ...form })).toBe(name);
  });
});

describe('toOptions', () => {
  const empty: FormState = { url: '', width: '', height: '', format: '', quality: '', crop: '' };

  it('omits blank fields so server defaults apply', () => {
    expect(toOptions({ ...empty, url: ' https://a.test/x.png ' })).toEqual({
      url: 'https://a.test/x.png',
    });
  });

  it('converts numeric fields and keeps chosen enums', () => {
    expect(
      toOptions({
        url: 'https://a.test/x.png',
        width: '500',
        height: '300',
        format: 'webp',
        quality: '70',
        crop: 'fill',
      }),
    ).toEqual({
      url: 'https://a.test/x.png',
      width: 500,
      height: 300,
      format: 'webp',
      quality: 70,
      crop: 'fill',
    });
  });

  it('passes odd numbers through so the validator can explain them', () => {
    expect(toOptions({ ...empty, url: 'u', width: '12.5' }).width).toBe(12.5);
  });

  it('drops crop when no dimension is set (the control is disabled then)', () => {
    expect(toOptions({ ...empty, url: 'u', crop: 'fill' })).toEqual({ url: 'u' });
  });

  it('drops quality for lossless formats (the control is disabled then)', () => {
    expect(toOptions({ ...empty, url: 'u', format: 'png', quality: '80' })).toEqual({
      url: 'u',
      format: 'png',
    });
  });
});
