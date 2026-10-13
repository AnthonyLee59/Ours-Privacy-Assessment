import { describe, expect, it } from 'vitest';
import { EMPTY_FORM } from '../src/lib/format';
import { formFromQuery, queryFromForm } from '../src/lib/url-state';

describe('queryFromForm', () => {
  it('is empty for an empty form', () => {
    expect(queryFromForm(EMPTY_FORM)).toBe('');
  });

  it('includes only filled fields, in a stable order', () => {
    expect(
      queryFromForm({ ...EMPTY_FORM, crop: 'fill', width: '600', url: 'https://a.test/x.png?v=1' }),
    ).toBe('?url=https%3A%2F%2Fa.test%2Fx.png%3Fv%3D1&width=600&crop=fill');
  });
});

describe('formFromQuery', () => {
  it('restores every field', () => {
    expect(
      formFromQuery(
        '?url=https%3A%2F%2Fa.test%2Fx.png&width=600&height=400&format=webp&quality=70&crop=fill',
      ),
    ).toEqual({
      url: 'https://a.test/x.png',
      width: '600',
      height: '400',
      format: 'webp',
      quality: '70',
      crop: 'fill',
    });
  });

  it('round-trips with queryFromForm', () => {
    const form = {
      ...EMPTY_FORM,
      url: 'https://a.test/x.png',
      height: '10',
      format: 'avif' as const,
    };
    expect(formFromQuery(queryFromForm(form))).toEqual(form);
  });

  it('ignores unknown keys and values that are not valid choices', () => {
    expect(formFromQuery('?url=u&format=bmp&crop=zoom&evil=1')).toEqual({
      ...EMPTY_FORM,
      url: 'u',
    });
  });

  it('keeps free-text fields as typed so validation can explain them', () => {
    expect(formFromQuery('?width=abc').width).toBe('abc');
  });
});
