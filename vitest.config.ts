import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const alias = { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer/src') };

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
            'src/{shared,main,pty-host,workspace-host,plugin-host}/**/*.test.ts',
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
          testTimeout: 30_000,
          pool: 'forks',
        },
      },
    ],
  },
});
