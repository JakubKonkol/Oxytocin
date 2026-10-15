import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const alias = { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer/src') };

/**
 * Integration tests that measure latency (e.g. a file write → git refresh within 300 ms). They run on their own,
 * after the other integration tests: next to the PTY Host's 20 MB flow-control test or the git lock test, a busy CI
 * runner (Windows) delays the file watcher by several hundred milliseconds.
 */
const LATENCY_TESTS = ['tests/integration/git-watch.test.ts'];

export default defineConfig({
  resolve: { alias },
  test: {
    passWithNoTests: true,
    coverage: { provider: 'v8', include: ['src/shared/**', 'src/**/services/**'] },
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit-node',
          environment: 'node',
          include: [
            'src/{shared,main,pty-host,workspace-host,plugin-host,connections-host}/**/*.test.ts',
            'plugins/*/src/host/**/*.test.ts',
            'packages/*/src/**/*.test.ts',
            'scripts/**/*.test.ts',
          ],
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: 'unit-web',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}', 'plugins/*/src/views/**/*.test.{ts,tsx}'],
          setupFiles: ['tests/setup/web.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          exclude: LATENCY_TESTS,
          testTimeout: 30_000,
          pool: 'forks',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration-latency',
          environment: 'node',
          include: LATENCY_TESTS,
          testTimeout: 30_000,
          pool: 'forks',
          fileParallelism: false,
        },
      },
    ],
  },
});
