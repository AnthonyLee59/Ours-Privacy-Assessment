import { z } from 'zod';
import {
  CROP_MODES,
  CROP_MODES_NEEDING_BOTH_DIMENSIONS,
  DEFAULT_CROP,
  FORMAT_ALIASES,
  LIMITS,
  LOSSY_FORMATS,
  OUTPUT_FORMATS,
  PARAM_NAMES,
} from './constants.js';
import type { CropMode, OutputFormat, ParamName } from './constants.js';
import type { FieldError } from './errors.js';

export interface ProcessParams {
  url: string;
  width?: number;
  height?: number;
  format?: OutputFormat;
  quality?: number;
  crop: CropMode;
}

export type ParseResult = { ok: true; value: ProcessParams } | { ok: false; errors: FieldError[] };

const notEmpty = (name: string) => `${name} must not be empty`;

function wholeNumber(name: string, min: number, max: number, example: number) {
  const range = `${name} must be between ${min} and ${max}`;
  return z
    .string()
    .min(1, notEmpty(name))
    .regex(
      /^\d+$/,
      `${name} must be a whole number between ${min} and ${max}, e.g. ${name}=${example}`,
    )
    .transform(Number)
    .pipe(z.number().min(min, range).max(max, range));
}

function oneOf<T extends readonly [string, ...string[]]>(name: string, values: T) {
  return z.enum(values, { error: `${name} must be one of: ${values.join(', ')}` });
}

const urlSchema = z
  .string({ error: 'url is required, e.g. url=https://example.com/image.jpg' })
  .min(1, notEmpty('url'))
  .max(LIMITS.maxUrlLength, `url must be at most ${LIMITS.maxUrlLength} characters`)
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'url must be an absolute http(s) URL, e.g. https://example.com/image.jpg',
      });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({
        code: 'custom',
        message: `url must use http or https (got "${parsed.protocol.slice(0, -1)}")`,
      });
    }
  });

const formatSchema = z
  .string()
  .min(1, notEmpty('format'))
  .transform((value) => {
    const lower = value.toLowerCase();
    return FORMAT_ALIASES[lower] ?? lower;
  })
  .pipe(oneOf('format', OUTPUT_FORMATS));

/** Field-level schema for `GET /v1/process` query parameters. */
export const processQuerySchema = z
  .object({
    url: urlSchema,
    width: wholeNumber('width', 1, LIMITS.maxDimension, 500).optional(),
    height: wholeNumber('height', 1, LIMITS.maxDimension, 300).optional(),
    format: formatSchema.optional(),
    quality: wholeNumber('quality', LIMITS.minQuality, LIMITS.maxQuality, 80).optional(),
    crop: oneOf('crop', CROP_MODES).default(DEFAULT_CROP),
  })
  .superRefine((params, ctx) => {
    const needsBoth = (CROP_MODES_NEEDING_BOTH_DIMENSIONS as readonly string[]).includes(
      params.crop,
    );
    if (needsBoth && (params.width === undefined || params.height === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['crop'],
        message: `crop=${params.crop} needs both width and height; add the missing one or use crop=fit`,
      });
    }
    const lossless =
      params.format !== undefined && !(LOSSY_FORMATS as readonly string[]).includes(params.format);
    if (params.quality !== undefined && lossless) {
      ctx.addIssue({
        code: 'custom',
        path: ['quality'],
        message: `quality only applies to ${LOSSY_FORMATS.join(', ')}; remove it or change format=${params.format}`,
      });
    }
  });

const MAX_SUGGESTION_DISTANCE = 2;

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost));
    }
    previous = current;
  }
  return previous[b.length]!;
}

function unknownParamMessage(name: string): string {
  const lower = name.toLowerCase();
  const closest = PARAM_NAMES.map((known) => ({
    known,
    distance: editDistance(lower, known),
  })).sort((a, b) => a.distance - b.distance)[0]!;
  if (closest.distance <= MAX_SUGGESTION_DISTANCE) {
    return `Unknown parameter "${name}". Did you mean "${closest.known}"?`;
  }
  return `Unknown parameter "${name}". Supported parameters: ${PARAM_NAMES.join(', ')}`;
}

function isParamName(name: string): name is ParamName {
  return (PARAM_NAMES as readonly string[]).includes(name);
}

/**
 * Validate `/v1/process` query parameters. Collects every problem (one per
 * parameter) so callers can fix them all in one round trip.
 */
export function parseProcessParams(query: URLSearchParams): ParseResult {
  // First error per parameter wins; Map preserves insertion order for unknown params.
  const errors = new Map<string, string>();
  const raw: Partial<Record<ParamName, string>> = {};

  for (const [name, value] of query) {
    if (!isParamName(name)) {
      if (!errors.has(name)) errors.set(name, unknownParamMessage(name));
    } else if (name in raw) {
      errors.set(name, `${name} was given more than once; pass it a single time`);
    } else {
      raw[name] = value;
    }
  }

  const result = processQuerySchema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const param = String(issue.path[0]);
      if (!errors.has(param)) errors.set(param, issue.message);
    }
  }

  if (errors.size > 0) {
    const order = (param: string) => {
      const index = (PARAM_NAMES as readonly string[]).indexOf(param);
      return index === -1 ? PARAM_NAMES.length : index;
    };
    const sorted = [...errors].sort(([a], [b]) => order(a) - order(b));
    return { ok: false, errors: sorted.map(([param, message]) => ({ param, message })) };
  }

  return { ok: true, value: result.data as ProcessParams };
}
