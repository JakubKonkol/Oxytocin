import { defineConfig } from '@playwright/test';

const ci = !!process.env['CI'];

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // One Electron app at a time: tests measure terminal output and agent states, which parallel apps would slow
  // down unevenly. CI splits the suite across machines instead (`--shard`, full-tests.yml).
  fullyParallel: false,
  workers: 1,
  // CI runners are slow and noisy (Windows especially): a test that fails once is retried and reported as flaky.
  retries: ci ? 2 : 0,
  reporter: ci ? [['list'], ['github'], ['html', { open: 'never' }]] : 'list',
  // Recording a trace for every test costs time; on CI only the retry of a failed test records one.
  use: { trace: ci ? 'on-first-retry' : 'retain-on-failure', screenshot: 'only-on-failure' },
});
