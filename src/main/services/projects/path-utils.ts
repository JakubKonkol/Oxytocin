import { posix, win32 } from 'node:path';

export function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

/** Case-insensitive file systems by default on Windows and macOS. */
export function isCaseInsensitive(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/** Normalized absolute path without a trailing separator (except for roots). */
export function normalizeRoot(path: string, platform: NodeJS.Platform): string {
  const p = pathApi(platform);
  let resolved = p.resolve(path);
  const root = p.parse(resolved).root;
  while (resolved.length > root.length && /[\\/]$/.test(resolved)) resolved = resolved.slice(0, -1);
  return resolved;
}

export function comparisonKey(path: string, platform: NodeJS.Platform): string {
  const n = normalizeRoot(path, platform);
  return isCaseInsensitive(platform) ? n.toLowerCase() : n;
}

/** True when `child` equals `parent` or lies inside it. */
export function isWithin(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const c = comparisonKey(child, platform);
  const p = comparisonKey(parent, platform);
  if (c === p) return true;
  const sep = platform === 'win32' ? '\\' : '/';
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}
