import { describe, expect, it } from 'vitest';
import { LIMITS, PARAM_NAMES, parseProcessParams } from '../src/index.js';
import type { FieldError, ProcessParams } from '../src/index.js';

const IMG = 'https://example.com/image.jpg';

function parse(query: string) {
  return parseProcessParams(new URLSearchParams(query));
}

function ok(query: string): ProcessParams {
  const result = parse(query);
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.errors)}`);
  return result.value;
}

function errors(query: string): FieldError[] {
  const result = parse(query);
  if (result.ok) throw new Error(`expected errors, got ${JSON.stringify(result.value)}`);
  return result.errors;
}

function errorFor(query: string, param: string): string {
  const match = errors(query).find((e) => e.param === param);
  if (!match) throw new Error(`no error for ${param} in ${JSON.stringify(errors(query))}`);
  return match.message;
}

describe('parseProcessParams — PDF example requests', () => {
  it('parses resize example', () => {
    expect(ok(`url=${IMG}&width=500&height=300`)).toEqual({
      url: IMG,
      width: 500,
      height: 300,
      crop: 'fit',
    });
  });

  it('parses format conversion example', () => {
    expect(ok('url=https://example.com/image.png&format=jpeg&quality=80')).toEqual({
      url: 'https://example.com/image.png',
      format: 'jpeg',
      quality: 80,
      crop: 'fit',
    });
  });

  it('parses combined operations example', () => {
    expect(ok(`url=${IMG}&width=800&height=600&format=webp&crop=fill`)).toEqual({
      url: IMG,
      width: 800,
      height: 600,
      format: 'webp',
      crop: 'fill',
    });
  });
});

describe('parseProcessParams — url', () => {
  it('accepts url alone (re-encode original)', () => {
    expect(ok(`url=${encodeURIComponent(IMG)}`)).toEqual({ url: IMG, crop: 'fit' });
  });

  it('keeps the source url query string intact when encoded', () => {
    const src = 'https://cdn.example.com/a.png?size=large&v=2';
    expect(ok(`url=${encodeURIComponent(src)}`).url).toBe(src);
  });

  it('accepts http scheme', () => {
    expect(ok('url=http://example.com/a.png').url).toBe('http://example.com/a.png');
  });

  it('requires url', () => {
    expect(errorFor('width=10', 'url')).toMatch(/required/i);
  });

  it('rejects empty url', () => {
    expect(errorFor('url=', 'url')).toMatch(/must not be empty/i);
  });

  it('rejects relative or malformed url', () => {
    expect(errorFor('url=/images/a.png', 'url')).toMatch(/absolute http\(s\) URL/i);
    expect(errorFor('url=not a url', 'url')).toMatch(/absolute http\(s\) URL/i);
  });

  it.each([
    'ftp://example.com/a.png',
    'file:///etc/passwd',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    'gopher://x/',
  ])('rejects non-http scheme %s', (url) => {
    expect(errorFor(`url=${encodeURIComponent(url)}`, 'url')).toMatch(/http or https/i);
  });

  it('rejects url longer than the limit', () => {
    const long = `https://example.com/${'a'.repeat(LIMITS.maxUrlLength)}`;
    expect(errorFor(`url=${long}`, 'url')).toMatch(new RegExp(`${LIMITS.maxUrlLength}`));
  });
});

describe('parseProcessParams — width and height', () => {
  it.each(['width', 'height'])('accepts %s alone', (param) => {
    expect(ok(`url=${IMG}&${param}=250`)).toMatchObject({ [param]: 250 });
  });

  it.each(['1', String(LIMITS.maxDimension)])('accepts boundary value %s', (value) => {
    expect(ok(`url=${IMG}&width=${value}`).width).toBe(Number(value));
  });

  it.each([
    ['0', /between 1 and/],
    [String(LIMITS.maxDimension + 1), /between 1 and/],
    ['-5', /whole number/],
    ['12.5', /whole number/],
    ['500px', /whole number/],
    ['1e3', /whole number/],
    ['0x10', /whole number/],
    [' 500', /whole number/],
    ['abc', /whole number/],
    ['99999999999999999999', /between 1 and/],
  ])('rejects width=%s', (value, message) => {
    expect(errorFor(`url=${IMG}&width=${encodeURIComponent(value)}`, 'width')).toMatch(message);
  });

  it('rejects empty height', () => {
    expect(errorFor(`url=${IMG}&height=`, 'height')).toMatch(/must not be empty/i);
  });
});

describe('parseProcessParams — format', () => {
  it.each(['jpeg', 'png', 'webp', 'avif', 'gif'])('accepts %s', (format) => {
    expect(ok(`url=${IMG}&format=${format}`).format).toBe(format);
  });

  it('normalises jpg alias to jpeg', () => {
    expect(ok(`url=${IMG}&format=jpg`).format).toBe('jpeg');
  });

  it('is case-insensitive', () => {
    expect(ok(`url=${IMG}&format=WEBP`).format).toBe('webp');
  });

  it.each(['svg', 'tiff', 'bmp', 'heic', 'mp4'])(
    'rejects unsupported output format %s and lists options',
    (format) => {
      const message = errorFor(`url=${IMG}&format=${format}`, 'format');
      expect(message).toMatch(/jpeg, png, webp, avif, gif/);
    },
  );
});

describe('parseProcessParams — quality', () => {
  it.each(['1', '80', '100'])('accepts %s', (value) => {
    expect(ok(`url=${IMG}&format=webp&quality=${value}`).quality).toBe(Number(value));
  });

  it.each(['0', '101', '50.5', 'high'])('rejects quality=%s', (value) => {
    expect(errorFor(`url=${IMG}&quality=${value}`, 'quality')).toMatch(/1 and 100|whole number/);
  });

  it.each(['png', 'gif'])(
    'rejects quality with explicit lossless format %s and says how to fix',
    (format) => {
      const message = errorFor(`url=${IMG}&format=${format}&quality=80`, 'quality');
      expect(message).toMatch(/jpeg, webp, avif/);
      expect(message).toMatch(new RegExp(format));
    },
  );

  it('allows quality without explicit format (applied only if the output is lossy)', () => {
    expect(ok(`url=${IMG}&quality=60`).quality).toBe(60);
  });
});

describe('parseProcessParams — crop', () => {
  it('defaults to fit', () => {
    expect(ok(`url=${IMG}&width=10&height=10`).crop).toBe('fit');
  });

  it.each(['fill', 'fit', 'limit', 'pad', 'scale'])(
    'accepts crop=%s with both dimensions',
    (crop) => {
      expect(ok(`url=${IMG}&width=10&height=10&crop=${crop}`).crop).toBe(crop);
    },
  );

  it.each(['fit', 'limit'])('accepts crop=%s with a single dimension', (crop) => {
    expect(ok(`url=${IMG}&width=10&crop=${crop}`).crop).toBe(crop);
  });

  it.each(['fill', 'pad', 'scale'])('requires both dimensions for crop=%s', (crop) => {
    expect(errorFor(`url=${IMG}&width=10&crop=${crop}`, 'crop')).toMatch(/both width and height/);
  });

  it('rejects unknown crop mode and lists options', () => {
    expect(errorFor(`url=${IMG}&crop=cover`, 'crop')).toMatch(/fill, fit, limit, pad, scale/);
  });
});

describe('parseProcessParams — request shape', () => {
  it('rejects unknown parameters and suggests the closest name', () => {
    expect(errorFor(`url=${IMG}&widht=10`, 'widht')).toMatch(/did you mean "width"/i);
  });

  it('rejects unknown parameters without a close match by listing supported ones', () => {
    expect(errorFor(`url=${IMG}&rotate=90`, 'rotate')).toMatch(new RegExp(PARAM_NAMES.join(', ')));
  });

  it('rejects duplicated parameters', () => {
    expect(errorFor(`url=${IMG}&width=10&width=20`, 'width')).toMatch(/more than once/);
  });

  it('reports a repeated unknown parameter once', () => {
    expect(errors(`url=${IMG}&foo=1&foo=2`)).toHaveLength(1);
  });

  it('reports duplicates instead of validating the second value', () => {
    expect(errorFor(`url=${IMG}&width=10&width=abc`, 'width')).toMatch(/more than once/);
  });

  it('lists unknown parameters after known ones', () => {
    const params = errors('foo=1&width=0').map((e) => e.param);
    expect(params).toEqual(['url', 'width', 'foo']);
  });

  it('reports every problem at once, not just the first', () => {
    const params = errors('width=0&format=bmp&crop=nope').map((e) => e.param);
    expect(params).toEqual(expect.arrayContaining(['url', 'width', 'format', 'crop']));
  });

  it('returns errors in a stable order (by parameter name order)', () => {
    const params = errors('crop=nope&width=0').map((e) => e.param);
    expect(params).toEqual(['url', 'width', 'crop']);
  });
});
