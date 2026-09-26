import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const alias = { '@shared': resolve('src/shared') };

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      rollupOptions: {
        // Utility processes are extra entries of the main build: out/main/<name>.js
        input: {
          index: resolve('src/main/index.ts'),
          ptyHost: resolve('src/pty-host/index.ts'),
          workspaceHost: resolve('src/workspace-host/index.ts'),
          pluginHost: resolve('src/plugin-host/index.ts'),
        },
      },
    },
  },
  preload: {
    resolve: { alias },
    build: {
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias: { ...alias, '@renderer': resolve('src/renderer/src') } },
    plugins: [react()],
    worker: { format: 'es' },
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } },
    },
  },
});
