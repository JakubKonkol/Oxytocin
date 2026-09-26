import { isAbsolute, resolve } from 'node:path';

/**
 * Folder paths passed on the command line (`Oxytocin.exe C:\dev\api`). Skips the executable, the app entry
 * (dev: `electron out/main/index.js`) and every flag, including `--user-data-dir <dir>`.
 */
export function projectPathsFromArgv(argv: readonly string[], opts: { isPackaged: boolean; cwd: string }): string[] {
  const args = argv.slice(opts.isPackaged ? 1 : 2);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--user-data-dir') {
      i++;
      continue;
    }
    if (arg.startsWith('-') || arg === '.') continue;
    out.push(isAbsolute(arg) ? arg : resolve(opts.cwd, arg));
  }
  return out;
}
