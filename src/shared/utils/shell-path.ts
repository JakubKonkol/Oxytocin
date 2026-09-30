/**
 * Paths agents report in other spellings: Git Bash / MSYS (`/c/work/app`), Cygwin (`/cygdrive/c/…`) and WSL
 * (`/mnt/c/work/app`) on Windows become `C:\work\app`. Other paths are returned unchanged.
 */
export function fromShellPath(path: string, platform: string): string {
  if (platform !== 'win32') return path;
  const m = /^\/(?:mnt\/|cygdrive\/)?([a-zA-Z])(\/.*)?$/.exec(path);
  if (!m) return path;
  return `${m[1]!.toUpperCase()}:${(m[2] ?? '/').replace(/\//g, '\\')}`;
}

/** Absolute on the given platform (after `fromShellPath`). */
export function isAbsolutePath(path: string, platform: string): boolean {
  return platform === 'win32' ? /^([a-zA-Z]:[\\/]|\\\\)/.test(path) : path.startsWith('/');
}
