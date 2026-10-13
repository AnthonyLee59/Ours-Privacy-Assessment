import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import express from 'express';
import type { RequestHandler } from 'express';
import helmet from 'helmet';
import { ConfigError } from './config.js';

/**
 * Directory of the built UI: STATIC_DIR if set (must exist), else the default
 * monorepo build location if present, else none (API-only deployment).
 */
export function resolveStaticDir(
  configured: string | undefined,
  fallback: string,
): string | undefined {
  if (configured !== undefined) {
    if (!existsSync(configured)) {
      throw new ConfigError([`STATIC_DIR: directory "${configured}" does not exist`]);
    }
    return configured;
  }
  return existsSync(fallback) ? fallback : undefined;
}

const HASHED_ASSETS = `${sep}assets${sep}`;

/**
 * Serves the UI with a page-specific CSP: the UI previews originals from any
 * http(s) host and shows processed images from blob: URLs. Scripts, styles
 * and fetches stay same-origin; the page cannot be framed.
 */
export function staticUi(dir: string): RequestHandler[] {
  return [
    helmet.contentSecurityPolicy({
      directives: {
        'img-src': ["'self'", 'data:', 'blob:', 'http:', 'https:'],
        'style-src': ["'self'"],
        'connect-src': ["'self'"],
        'frame-ancestors': ["'none'"],
        'upgrade-insecure-requests': null,
      },
    }),
    express.static(dir, {
      dotfiles: 'ignore',
      redirect: false,
      setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (path.includes(HASHED_ASSETS)) {
          // Vite fingerprints everything under assets/, so it can be cached forever.
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=3600');
        }
      },
    }),
  ];
}
