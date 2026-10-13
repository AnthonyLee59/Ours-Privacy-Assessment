import { Router } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';

/**
 * `/openapi.json` plus Swagger UI at `/docs`, served from our own origin (no
 * CDN). Swagger UI needs inline styles, and data:/blob: images to preview
 * image responses, so the CSP is relaxed for these pages only.
 */
export function docsRouter(document: Record<string, unknown>): Router {
  const router = Router();

  router.get('/openapi.json', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(document);
  });

  router.use(
    '/docs',
    helmet.contentSecurityPolicy({
      directives: {
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'upgrade-insecure-requests': null,
      },
    }),
    swaggerUi.serve,
    swaggerUi.setup(document, { customSiteTitle: 'Image Processing API docs' }),
  );

  return router;
}
