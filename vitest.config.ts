import { defineConfig } from 'vitest/config';

// Each workspace package owns its own vitest config; the root just fans out
// and aggregates coverage so CI has one command and one threshold gate.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/test/**',
        '**/*.d.ts',
        'apps/api/src/main.ts',
        'apps/web/src/main.tsx',
      ],
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
});
