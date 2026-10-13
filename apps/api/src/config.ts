import ipaddr from 'ipaddr.js';
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const MB = 1024 * 1024;

// A hostname, optionally prefixed with "*." to allow any subdomain.
const HOST_PATTERN = /^(\*\.)?([a-z0-9-]+\.)*[a-z0-9-]+$/;

const hostList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  )
  .superRefine((entries, ctx) => {
    for (const entry of entries.filter((e) => !HOST_PATTERN.test(e))) {
      ctx.addIssue({
        code: 'custom',
        message: `"${entry}" is not a hostname (use e.g. images.example.com or *.example.com)`,
      });
    }
  });

const NAMED_PROXY_RANGES = ['loopback', 'linklocal', 'uniquelocal'];

function isProxyAddress(entry: string): boolean {
  if (NAMED_PROXY_RANGES.includes(entry)) return true;
  if (entry.includes('/')) {
    try {
      ipaddr.parseCIDR(entry);
      return true;
    } catch {
      return false;
    }
  }
  return ipaddr.IPv4.isValidFourPartDecimal(entry) || ipaddr.IPv6.isValid(entry);
}

/**
 * Express "trust proxy": `false`, a hop count, or proxy addresses. `true`
 * (trust every hop) is refused: any client could then choose its own IP via
 * X-Forwarded-For and dodge the rate limit.
 */
const trustProxy = z.string().transform((value, ctx): false | number | string[] => {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'false') return false;
  if (trimmed === 'true') {
    ctx.addIssue({
      code: 'custom',
      message:
        'true would trust spoofed X-Forwarded-For; set the number of proxy hops (e.g. 1) or proxy IPs/CIDRs',
    });
    return z.NEVER;
  }
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const entries = trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries.filter((e) => !isProxyAddress(e))) {
    ctx.addIssue({
      code: 'custom',
      message: `"${entry}" is not an IP, CIDR, or one of ${NAMED_PROXY_RANGES.join(', ')}`,
    });
  }
  return entries;
});

/** Whole number from an env string, within [min, max], with a default. */
function int(min: number, max: number, fallback: number) {
  const range = `must be between ${min} and ${max}`;
  return z
    .string()
    .regex(/^\d+$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().min(min, range).max(max, range))
    .default(fallback);
}

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'], {
      error: 'must be one of development, production, test',
    })
    .default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: int(1, 65535, 3000),
  LOG_LEVEL: z
    .enum(LOG_LEVELS, { error: `must be one of ${LOG_LEVELS.join(', ')}` })
    .default('info'),
  ALLOWED_HOSTS: hostList.default([]),
  MAX_SOURCE_BYTES: int(1, 100 * MB, 15 * MB),
  FETCH_TIMEOUT_MS: int(100, 60_000, 10_000),
  MAX_REDIRECTS: int(0, 10, 3),
  MAX_INPUT_PIXELS: int(1, 268_402_689, 40_000_000),
  PROCESSING_TIMEOUT_SECONDS: int(1, 60, 10),
  PROCESSING_CONCURRENCY: int(1, 64, 4),
  PROCESSING_QUEUE_SIZE: int(0, 1000, 20),
  // 0 disables the result cache.
  CACHE_MAX_BYTES: int(0, 4096 * MB, 128 * MB),
  CACHE_TTL_SECONDS: int(1, 7 * 24 * 3600, 3600),
  // 0 disables rate limiting (e.g. when a CDN/WAF in front already does it).
  RATE_LIMIT_PER_MINUTE: int(0, 100_000, 60),
  TRUST_PROXY: trustProxy.default(false),
  STATIC_DIR: z.string().optional(),
});

export interface Config {
  nodeEnv: 'development' | 'production' | 'test';
  host: string;
  port: number;
  logLevel: (typeof LOG_LEVELS)[number];
  /** Empty means any public host may be fetched. */
  allowedHosts: string[];
  maxSourceBytes: number;
  /** Total deadline for fetching a source, across redirects and body. */
  fetchTimeoutMs: number;
  maxRedirects: number;
  maxInputPixels: number;
  processingTimeoutSeconds: number;
  /** Fetch+process jobs allowed to run at once. */
  processingConcurrency: number;
  /** Jobs allowed to wait for a slot before new ones get 503. */
  processingQueueSize: number;
  cacheMaxBytes: number;
  cacheTtlSeconds: number;
  /** Requests per client IP per minute on processing routes; 0 disables. */
  rateLimitPerMinute: number;
  /** Express "trust proxy" setting; decides which address counts as the client IP. */
  trustProxy: false | number | string[];
  /** Built UI to serve at /. Unset: the monorepo build location if it exists. */
  staticDir: string | undefined;
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n  ${issues.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

/** Parse and validate configuration from environment variables. Throws ConfigError listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Empty strings count as unset so `PORT=` in a .env file falls back to the default.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const result = envSchema.safeParse(present);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${String(issue.path[0])}: ${issue.message}`),
    );
  }
  const parsed = result.data;
  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    allowedHosts: parsed.ALLOWED_HOSTS,
    maxSourceBytes: parsed.MAX_SOURCE_BYTES,
    fetchTimeoutMs: parsed.FETCH_TIMEOUT_MS,
    maxRedirects: parsed.MAX_REDIRECTS,
    maxInputPixels: parsed.MAX_INPUT_PIXELS,
    processingTimeoutSeconds: parsed.PROCESSING_TIMEOUT_SECONDS,
    processingConcurrency: parsed.PROCESSING_CONCURRENCY,
    processingQueueSize: parsed.PROCESSING_QUEUE_SIZE,
    cacheMaxBytes: parsed.CACHE_MAX_BYTES,
    cacheTtlSeconds: parsed.CACHE_TTL_SECONDS,
    rateLimitPerMinute: parsed.RATE_LIMIT_PER_MINUTE,
    trustProxy: parsed.TRUST_PROXY,
    staticDir: parsed.STATIC_DIR,
  };
}
