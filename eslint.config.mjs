import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const NODE_BUILTINS = ['fs', 'path', 'os', 'child_process', 'crypto', 'events', 'stream', 'util', 'url'];

/** Directory boundaries from docs/plan/01-architecture.md §3. */
const boundary = (files, patterns, message, paths = []) => ({
  files,
  rules: {
    'no-restricted-imports': [
      'error',
      { paths: paths.map((name) => ({ name, message })), patterns: [{ group: patterns, message }] },
    ],
  },
});

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'release/**',
      'coverage/**',
      'node_modules/**',
      'test-results/**',
      'playwright-report/**',
      'docs/**',
      '**/dist/**',
      'spikes/**',
      // Generated copies of the view SDK used by E2E fixture plugins.
      'tests/fixtures/plugins/*/oxy-sdk.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      'no-console': 'error',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: [
      'src/renderer/**/*.{ts,tsx}',
      'packages/plugin-sdk/**/*.{ts,tsx}',
      'plugins/*/src/views/**/*.{ts,tsx}',
      'tests/fixtures/plugins/*/view*.js',
    ],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    // Colors live in tokens.css only (ADR-014).
    files: ['**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/#[0-9a-fA-F]{3,8}\\b/]',
          message: 'Use CSS tokens (var(--…)) instead of color literals.',
        },
      ],
    },
  },
  boundary(
    ['src/shared/**/*.ts'],
    [
      'node:*',
      '**/main/**',
      '**/renderer/**',
      '**/pty-host/**',
      '**/workspace-host/**',
      '**/plugin-host/**',
      '**/preload/**',
    ],
    'src/shared must stay pure TypeScript and only import from src/shared.',
    ['electron', ...NODE_BUILTINS],
  ),
  boundary(
    ['src/renderer/**/*.{ts,tsx}'],
    ['node:*', '**/main/**', '**/pty-host/**', '**/workspace-host/**', '**/plugin-host/**', '**/preload/**'],
    'The renderer may only import src/shared and its own modules.',
    ['electron', ...NODE_BUILTINS],
  ),
  boundary(
    ['src/pty-host/**/*.ts', 'src/workspace-host/**/*.ts', 'src/plugin-host/**/*.ts'],
    ['**/main/**', '**/renderer/**', '**/preload/**'],
    'Hosts talk to main over RPC only; import src/shared and their own modules.',
  ),
  boundary(
    ['src/main/**/*.ts'],
    ['**/pty-host/**', '**/workspace-host/**', '**/plugin-host/**', '**/renderer/**'],
    'Main talks to hosts over RPC only; never import host code.',
  ),
  boundary(
    ['plugins/*/src/**/*.{ts,tsx}'],
    ['**/src/main/**', '**/src/renderer/**', '**/src/shared/**', '@shared/*'],
    'Built-in plugins use the public API only (@oxytocin/plugin-api, @oxytocin/plugin-sdk).',
    ['electron'],
  ),
  {
    files: ['scripts/**/*.ts', 'tests/**/*.ts', '**/*.test.{ts,tsx}', '*.config.{ts,mjs}'],
    rules: { 'no-console': 'off' },
  },
);
