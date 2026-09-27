import { defineConfig } from '@playwright/test';

/** Packaged smoke test (release workflow): `OXYTOCIN_EXECUTABLE=<app> npx playwright test -c tests/smoke`. */
export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
