import { CROP_MODES, OUTPUT_FORMATS } from '@image-service/sdk';
import { EMPTY_FORM } from './format';
import type { FormState } from './format';

const FIELDS = ['url', 'width', 'height', 'format', 'quality', 'crop'] as const;

/** Page query string mirroring the form (only filled fields), e.g. "?url=…&width=600". */
export function queryFromForm(form: FormState): string {
  const params = new URLSearchParams();
  for (const field of FIELDS) {
    if (form[field] !== '') params.set(field, form[field]);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * Form state from a shared link. Free-text fields are kept as typed (validation
 * explains them); choice fields accept only known values; unknown keys are ignored.
 */
export function formFromQuery(search: string): FormState {
  const params = new URLSearchParams(search);
  const text = (name: (typeof FIELDS)[number]) => params.get(name) ?? '';
  const format = text('format');
  const crop = text('crop');
  return {
    ...EMPTY_FORM,
    url: text('url'),
    width: text('width'),
    height: text('height'),
    quality: text('quality'),
    format: (OUTPUT_FORMATS as readonly string[]).includes(format)
      ? (format as FormState['format'])
      : '',
    crop: (CROP_MODES as readonly string[]).includes(crop) ? (crop as FormState['crop']) : '',
  };
}
