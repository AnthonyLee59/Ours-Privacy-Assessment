import { defineProject } from 'vitest/config';

export default defineProject({
  // Resolve workspace packages to TypeScript source so tests need no build step.
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    name: 'api',
    environment: 'node',
  },
});
