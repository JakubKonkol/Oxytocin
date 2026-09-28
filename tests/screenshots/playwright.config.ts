import { defineConfig } from '@playwright/test';

/** README screenshots (`npm run screenshots`): builds nothing, run `npm run build` first. Not part of `npm run e2e`. */
export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: 'list',
});
