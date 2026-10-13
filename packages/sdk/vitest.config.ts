import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    name: 'sdk',
    environment: 'node',
  },
});
