import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API = process.env.API_ORIGIN ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  // Resolve workspace packages (the SDK) to TypeScript source: no pre-build needed.
  resolve: { conditions: ['source'] },
  server: {
    port: 5173,
    // In development the UI calls the API through Vite, so it stays same-origin like production.
    proxy: Object.fromEntries(
      ['/v1', '/process', '/healthz', '/docs', '/openapi.json'].map((path) => [path, API]),
    ),
  },
  build: { outDir: 'dist', sourcemap: true },
});
