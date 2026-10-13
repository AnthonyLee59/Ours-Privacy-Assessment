import {
  CROP_MODES,
  DEFAULT_CROP,
  ERRORS,
  LIMITS,
  OUTPUT_FORMATS,
  PARAM_NAMES,
} from '@image-service/contract';
import { Validator } from '@seriousme/openapi-schema-validator';
import type { SpecData } from '@seriousme/openapi-schema-validator';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { silentLogger, testConfig } from './helpers.js';

const app = createApp({ config: testConfig, logger: silentLogger });

interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  schema: Record<string, unknown>;
}
interface Operation {
  parameters?: Parameter[];
  responses: Record<
    string,
    { headers?: Record<string, unknown>; content?: Record<string, unknown> }
  >;
}
interface Spec {
  openapi: string;
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, { properties: Record<string, { enum?: string[] }> }> };
}

let spec: Spec;

beforeAll(async () => {
  const res = await request(app).get('/openapi.json');
  expect(res.status).toBe(200);
  spec = res.body as Spec;
});

const processOp = () => spec.paths['/v1/process']!.get!;
const param = (name: string) => processOp().parameters!.find((p) => p.name === name)!;

describe('GET /openapi.json', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    expect(spec.openapi).toMatch(/^3\.1\./);
    const result = await new Validator().validate(spec as unknown as SpecData);
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('is served as cacheable JSON', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
  });
});

describe('spec stays in sync with the contract', () => {
  it('documents exactly the parameters the API accepts', () => {
    expect(processOp().parameters!.map((p) => p.name)).toEqual([...PARAM_NAMES]);
    expect(param('url').required).toBe(true);
  });

  it.each(['width', 'height'])('documents %s bounds from LIMITS', (name) => {
    expect(param(name).schema).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: LIMITS.maxDimension,
    });
  });

  it('documents quality bounds and default', () => {
    expect(param('quality').schema).toMatchObject({
      type: 'integer',
      minimum: LIMITS.minQuality,
      maximum: LIMITS.maxQuality,
      default: LIMITS.defaultQuality,
    });
  });

  it('documents format and crop enums from the contract', () => {
    expect(param('format').schema.enum).toEqual([...OUTPUT_FORMATS, 'jpg']);
    expect(param('crop').schema).toMatchObject({ enum: [...CROP_MODES], default: DEFAULT_CROP });
  });

  it('documents every error code', () => {
    expect(spec.components.schemas.ProblemDetails!.properties.code!.enum).toEqual(
      Object.keys(ERRORS),
    );
  });

  it('documents every status /v1/process can return', () => {
    const statuses = Object.keys(processOp().responses).sort();
    expect(statuses).toEqual(
      ['200', '304', '400', '405', '413', '415', '422', '429', '500', '502', '503', '504'].sort(),
    );
  });

  it('documents the response headers clients rely on', () => {
    const headers = Object.keys(processOp().responses['200']!.headers!);
    expect(headers).toEqual(
      expect.arrayContaining([
        'ETag',
        'Cache-Control',
        'X-Cache',
        'X-Source-Width',
        'X-Source-Height',
        'X-Source-Format',
        'X-Source-Bytes',
        'X-Output-Width',
        'X-Output-Height',
        'X-Request-Id',
        'RateLimit',
      ]),
    );
    expect(Object.keys(processOp().responses['429']!.headers!)).toContain('Retry-After');
  });

  it('documents every output content type', () => {
    expect(Object.keys(processOp().responses['200']!.content!)).toEqual(
      OUTPUT_FORMATS.map((format) => `image/${format}`),
    );
  });

  it('every documented path exists on the app', async () => {
    for (const path of Object.keys(spec.paths)) {
      const res = await request(app).get(path);
      expect(res.body?.code, path).not.toBe('NOT_FOUND');
    }
  });

  it('documents the /process alias identically to /v1/process', () => {
    expect(spec.paths['/process']!.get!.parameters).toEqual(processOp().parameters);
  });
});

describe('GET /docs', () => {
  it('serves interactive docs from our own origin', async () => {
    const res = await request(app).get('/docs/');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/swagger-ui/i);
    expect(res.text).not.toMatch(/https?:\/\/(cdn|unpkg|cdnjs)/);
    const asset = await request(app).get('/docs/swagger-ui-bundle.js');
    expect(asset.status).toBe(200);
  });

  it('relaxes CSP only as far as the docs page needs', async () => {
    const csp = String((await request(app).get('/docs/')).headers['content-security-policy']);
    expect(csp).toMatch(/script-src 'self'(;|$)/);
    expect(csp).toMatch(/style-src 'self' 'unsafe-inline'/);
    expect(csp).toMatch(/img-src 'self' data: blob:/);
  });

  it('keeps the strict default CSP everywhere else', async () => {
    const csp = String((await request(app).get('/healthz')).headers['content-security-policy']);
    expect(csp).not.toMatch(/unsafe-inline'[^;]*;?\s*$/m);
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).not.toMatch(/style-src[^;]*unsafe-inline/);
  });
});
