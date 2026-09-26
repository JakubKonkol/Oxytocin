import { resolve } from 'node:path';
import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { buildShellCsp } from './src/shared/security/csp';

const alias = { '@shared': resolve('src/shared') };

/** Injects the shell CSP as a meta tag; in production the app:// handler also sends it as a header. */
function cspMetaPlugin(): Plugin {
  let dev = false;
  return {
    name: 'oxytocin-csp-meta',
    configResolved(config) {
      dev = config.command === 'serve';
    },
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: buildShellCsp({ dev }) },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

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
    plugins: [react(), tailwind(), cspMetaPlugin()],
    worker: { format: 'es' },
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } },
    },
  },
});
