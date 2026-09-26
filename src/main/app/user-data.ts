import { isAbsolute, resolve } from 'node:path';

/**
 * Resolves the userData override from `--user-data-dir=<path>` or `OXYTOCIN_USER_DATA_DIR`
 * (E2E tests, multiple profiles). The CLI flag wins over the environment variable.
 */
export function resolveUserDataOverride(argv: readonly string[], env: NodeJS.ProcessEnv): string | null {
  let fromArgs: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith('--user-data-dir=')) {
      fromArgs = arg.slice('--user-data-dir='.length);
    } else if (arg === '--user-data-dir' && argv[i + 1] !== undefined) {
      fromArgs = argv[i + 1] ?? null;
    }
  }
  const value = fromArgs ?? env['OXYTOCIN_USER_DATA_DIR'] ?? null;
  if (!value) return null;
  return isAbsolute(value) ? value : resolve(value);
}
