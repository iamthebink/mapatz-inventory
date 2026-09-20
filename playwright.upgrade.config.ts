import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/desktop',
  testMatch: 'windows-upgrade.spec.ts',
  outputDir: 'test-results-upgrade',
  workers: 1,
  use: { trace: 'retain-on-failure' },
  retries: 0, // Retrying on a used installation would invalidate the baseline.
  timeout: 240_000,
});
