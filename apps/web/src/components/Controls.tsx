import { CROP_MODES, LIMITS, OUTPUT_FORMATS } from '@image-service/sdk';
import type { CropMode, OutputFormat } from '@image-service/sdk';
import type { FormEvent } from 'react';
import { CROP_HELP, CROP_LABELS, SAMPLES } from '../lib/content';
import { LOSSLESS_FORMATS } from '../lib/format';
import type { FormState } from '../lib/format';

interface ControlsProps {
  form: FormState;
  fieldErrors: Partial<Record<string, string>>;
  canSubmit: boolean;
  loading: boolean;
  onChange: (patch: Partial<FormState>) => void;
  onSubmit: () => void;
}

/** aria-describedby value joining help and error ids that exist. */
function describedBy(...ids: (string | false | undefined)[]): string | undefined {
  const present = ids.filter(Boolean);
  return present.length > 0 ? present.join(' ') : undefined;
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p className="field-error" id={id}>
      {message}
    </p>
  );
}

export function Controls({
  form,
  fieldErrors,
  canSubmit,
  loading,
  onChange,
  onSubmit,
}: ControlsProps) {
  const hasSize = form.width !== '' || form.height !== '';
  const qualityDisabled = LOSSLESS_FORMATS.includes(form.format);
  const error = (param: string) => fieldErrors[param];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit) onSubmit();
  };

  return (
    <form className="card controls" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor="url">Image URL</label>
        <input
          id="url"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://example.com/photo.jpg"
          value={form.url}
          aria-invalid={error('url') ? true : undefined}
          aria-describedby={describedBy(error('url') && 'url-error')}
          onChange={(e) => onChange({ url: e.target.value })}
        />
        <FieldError id="url-error" message={error('url')} />
        <div className="samples" aria-label="Sample sources">
          {SAMPLES.map((sample) => (
            <button
              key={sample.url}
              type="button"
              className={`chip ${sample.kind === 'error' ? 'chip-warn' : ''}`}
              aria-label={`Sample: ${sample.label}`}
              title={sample.url}
              onClick={() => onChange({ url: sample.url })}
            >
              {sample.label}
            </button>
          ))}
        </div>
      </div>

      <fieldset className="group">
        <legend>Size</legend>
        <div className="row">
          {(['width', 'height'] as const).map((dimension) => (
            <div className="field" key={dimension}>
              <label htmlFor={dimension}>
                {dimension === 'width' ? 'Width' : 'Height'} <span className="unit">px</span>
              </label>
              <input
                id={dimension}
                type="number"
                min={1}
                max={LIMITS.maxDimension}
                step={1}
                placeholder="auto"
                value={form[dimension]}
                aria-invalid={error(dimension) ? true : undefined}
                aria-describedby={describedBy(error(dimension) && `${dimension}-error`)}
                onChange={(e) => onChange({ [dimension]: e.target.value })}
              />
              <FieldError id={`${dimension}-error`} message={error(dimension)} />
            </div>
          ))}
        </div>

        <div className="field">
          <label htmlFor="crop">Crop mode</label>
          <select
            id="crop"
            value={form.crop}
            disabled={!hasSize}
            aria-invalid={error('crop') ? true : undefined}
            aria-describedby={describedBy('crop-help', error('crop') && 'crop-error')}
            onChange={(e) => onChange({ crop: e.target.value as FormState['crop'] })}
          >
            <option value="">Fit (default)</option>
            {CROP_MODES.filter((mode) => mode !== 'fit').map((mode: CropMode) => (
              <option key={mode} value={mode}>
                {CROP_LABELS[mode]}
              </option>
            ))}
          </select>
          <p className="help" id="crop-help">
            {hasSize
              ? CROP_HELP[form.crop || 'fit']
              : 'Set a width or height to choose how the image fits.'}
          </p>
          <FieldError id="crop-error" message={error('crop')} />
        </div>
      </fieldset>

      <fieldset className="group">
        <legend>Output</legend>
        <div className="row">
          <div className="field">
            <label htmlFor="format">Format</label>
            <select
              id="format"
              value={form.format}
              aria-invalid={error('format') ? true : undefined}
              aria-describedby={describedBy(error('format') && 'format-error')}
              onChange={(e) => onChange({ format: e.target.value as FormState['format'] })}
            >
              <option value="">Same as source</option>
              {OUTPUT_FORMATS.map((format: OutputFormat) => (
                <option key={format} value={format}>
                  {format.toUpperCase()}
                </option>
              ))}
            </select>
            <FieldError id="format-error" message={error('format')} />
          </div>
          <div className="field">
            <label htmlFor="quality">Quality</label>
            <input
              id="quality"
              type="number"
              min={LIMITS.minQuality}
              max={LIMITS.maxQuality}
              step={1}
              placeholder={String(LIMITS.defaultQuality)}
              value={qualityDisabled ? '' : form.quality}
              disabled={qualityDisabled}
              aria-invalid={error('quality') ? true : undefined}
              aria-describedby={describedBy('quality-help', error('quality') && 'quality-error')}
              onChange={(e) => onChange({ quality: e.target.value })}
            />
            <FieldError id="quality-error" message={error('quality')} />
          </div>
        </div>
        <p className="help" id="quality-help">
          {qualityDisabled
            ? `${form.format.toUpperCase()} is lossless, so quality does not apply.`
            : 'Quality 1–100 applies to JPEG, WebP and AVIF.'}
        </p>
      </fieldset>

      <button
        className="primary"
        type="submit"
        disabled={!canSubmit}
        aria-busy={loading || undefined}
      >
        {/* Name stays constant for assistive tech; progress is announced by the status region. */}
        {loading && <span className="spinner" aria-hidden="true" />}
        Process image
      </button>
    </form>
  );
}
