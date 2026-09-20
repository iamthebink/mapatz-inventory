import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/desktop',
  testIgnore: '**/windows-upgrade.spec.ts',
  outputDir: 'test-results-desktop',
  workers: 1,
  timeout: 60_000,
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
