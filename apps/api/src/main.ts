// Process entry point: wiring only. Behaviour lives in modules that are unit tested.
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp, createFetcherFromConfig } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import type { Config } from './config.js';
import { createLogger } from './logger.js';
import { startServer } from './server.js';
import { resolveStaticDir } from './static.js';

// apps/api/{src,dist}/main -> apps/web/dist
const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));

const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  let config: Config;
  try {
    const loaded = loadConfig();
    config = { ...loaded, staticDir: resolveStaticDir(loaded.staticDir, DEFAULT_STATIC_DIR) };
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  // libvips' operation cache keeps decoded images in memory; results are cached
  // (with a byte budget) at the HTTP layer instead.
  sharp.cache(false);

  const logger = createLogger(config);
  const fetcher = createFetcherFromConfig(config);
  const app = createApp({ config, logger, fetcher });
  const running = await startServer(app, { host: config.host, port: config.port });
  logger.info(
    { url: running.url, env: config.nodeEnv, ui: config.staticDir ?? 'not served' },
    'image service listening',
  );

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down: draining in-flight requests');
    // Hard stop if draining takes too long (e.g. a stuck upstream fetch).
    setTimeout(() => {
      logger.error('shutdown grace period exceeded; exiting');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();
    running
      .close()
      .then(() => fetcher.close())
      .then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error({ err: error }, 'error while closing server');
          process.exit(1);
        },
      );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error('fatal startup error', error);
  process.exit(1);
});
