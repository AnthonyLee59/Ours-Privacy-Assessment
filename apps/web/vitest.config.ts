import react from '@vitejs/plugin-react';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [react()],
  resolve: { conditions: ['source'] },
  test: {
    name: 'web',
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
  },
});
