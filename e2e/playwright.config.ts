import { defineConfig, devices } from '@playwright/test';

const CI = Boolean(process.env.CI);
const BASE_URL = 'http://127.0.0.1:4598';

export default defineConfig({
  testDir: './tests',
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    // The browser loads original previews straight from the fake upstream host.
    launchOptions: { args: ['--host-resolver-rules=MAP img.test 127.0.0.1'] },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    // Build the real UI bundle, then serve it with the API (see harness.ts).
    command: 'pnpm --filter @image-service/web build && tsx --conditions=source harness.ts',
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: !CI,
    timeout: 120_000,
    stdout: 'pipe',
  },
});
