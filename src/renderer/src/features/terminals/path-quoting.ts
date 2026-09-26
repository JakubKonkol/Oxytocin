/** Shell families as reported by TerminalInfo.shellType. */
export type ShellType = 'pwsh' | 'powershell' | 'cmd' | 'git-bash' | 'wsl' | 'bash' | 'zsh' | 'fish' | 'sh' | 'other';

const SAFE_POSIX = /^[\w@%+=:,./-]+$/;

function posixQuote(path: string): string {
  if (SAFE_POSIX.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** C:\a\b → /c/a/b (Git Bash) or /mnt/c/a/b (WSL). */
export function windowsToPosixPath(path: string, style: 'git-bash' | 'wsl'): string {
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(path);
  if (!m) return path.replace(/\\/g, '/');
  const drive = m[1]!.toLowerCase();
  const rest = m[2]!.replace(/\\/g, '/');
  return style === 'wsl' ? `/mnt/${drive}/${rest}` : `/${drive}/${rest}`;
}

/** Quotes one path for pasting into a shell of the given type. */
export function quotePathForShell(path: string, shell: ShellType): string {
  switch (shell) {
    case 'pwsh':
    case 'powershell':
      return /^[\w:\\/.-]+$/.test(path) ? path : `'${path.replace(/'/g, "''")}'`;
    case 'cmd':
      return /[\s&()[\]{}^=;!'+,`~%]/.test(path) ? `"${path.replace(/"/g, '')}"` : path;
    case 'git-bash':
      return posixQuote(windowsToPosixPath(path, 'git-bash'));
    case 'wsl':
      return posixQuote(/^[A-Za-z]:/.test(path) ? windowsToPosixPath(path, 'wsl') : path);
    default:
      return posixQuote(path);
  }
}

/** Space-separated, quoted paths (a trailing space lets the user keep typing). */
export function formatDroppedPaths(paths: readonly string[], shell: ShellType): string {
  return paths.length === 0 ? '' : `${paths.map((p) => quotePathForShell(p, shell)).join(' ')} `;
}
