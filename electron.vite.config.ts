import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { buildShellCsp } from './src/shared/security/csp';

const alias = { '@shared': resolve('src/shared') };

/**
 * Database drivers and parsers of the Connections Host are bundled into out/main (only runtime-loaded modules ship in
 * app.asar's node_modules). libpg-query stays external: it loads its WebAssembly file next to its own module.
 */
const BUNDLED_DEPS = [
  'pg',
  'mysql2',
  'mssql',
  'mongodb',
  'ioredis',
  '@clickhouse/client',
  'oracledb',
  'node-sql-parser',
  'yaml',
];
/** Optional modules the drivers try to load (compression, Kerberos, cloud auth): absent, so they stay external. */
const OPTIONAL_DRIVER_DEPS = [
  'pg-native',
  'kerberos',
  '@mongodb-js/zstd',
  '@mongodb-js/kerberos',
  'snappy',
  'socks',
  'aws4',
  'mongodb-client-encryption',
  'gcp-metadata',
  '@aws-sdk/credential-providers',
  'cardinal',
  'bufferutil',
  'utf-8-validate',
];
const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string };

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
    // `app.getVersion()` returns Electron's version when the app runs from out/ (dev, E2E).
    define: { __OXYTOCIN_VERSION__: JSON.stringify(version) },
    build: {
      externalizeDeps: { exclude: BUNDLED_DEPS },
      rollupOptions: {
        external: OPTIONAL_DRIVER_DEPS,
        // Utility processes are extra entries of the main build: out/main/<name>.js
        input: {
          index: resolve('src/main/index.ts'),
          ptyHost: resolve('src/pty-host/index.ts'),
          workspaceHost: resolve('src/workspace-host/index.ts'),
          pluginHost: resolve('src/plugin-host/index.ts'),
          connectionsHost: resolve('src/connections-host/index.ts'),
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
