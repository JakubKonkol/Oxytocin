import { execFile } from 'node:child_process';
import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { atomicWrite } from './writer';
import { hasCode, rejectLink } from './paths';

const comment = '# Oxytocin local data (Code Map)';
export async function isMapGitIgnored(root: string, gitPath: string): Promise<boolean> {
  try {
    await promisify(execFile)(gitPath, ['--no-optional-locks', 'check-ignore', '-q', '.oxy/code-map/MAP.md'], {
      cwd: root,
      windowsHide: true,
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}
export function ensureOxyIgnored(text: string): string | null {
  if (text.split(/\r?\n/).some((line) => ['.oxy', '.oxy/', '/.oxy', '/.oxy/'].includes(line.trim()))) return null;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const separator = text && text !== '\ufeff' && !text.endsWith('\n') ? eol : '';
  return `${text}${separator}${comment}${eol}/.oxy/${eol}`;
}

export function removeOxyEntry(text: string): string | null {
  const expression = /(^|\n|^\ufeff)# Oxytocin local data \(Code Map\)\r?\n\/\.oxy\/(?:\r?\n|$)/;
  if (!expression.test(text)) return null;
  return text.replace(expression, '$1');
}

export async function updateProjectGitignore(options: {
  root: string;
  mode: 'project' | 'worktree';
  gitPath: string;
  ignoreInGit: boolean;
  removeGitignoreEntry: boolean;
}): Promise<string | null> {
  if (options.mode === 'worktree') return null;
  const root = await realpath(options.root);
  try {
    const { stdout } = await promisify(execFile)(
      options.gitPath,
      ['--no-optional-locks', 'rev-parse', '--is-inside-work-tree'],
      { cwd: root, windowsHide: true, timeout: 10_000, maxBuffer: 65536 },
    );
    if (stdout.trim() !== 'true') return null;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 128) return null;
    throw error;
  }
  if (!options.ignoreInGit && !options.removeGitignoreEntry) return null;
  const path = join(root, '.gitignore');
  await rejectLink(path);
  let text = '';
  try {
    const info = await lstat(path);
    if (!info.isFile() || !(info.mode & 0o222)) throw new Error('Project .gitignore is not writable');
    await access(path, constants.W_OK);
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
  const next = options.ignoreInGit ? ensureOxyIgnored(text) : removeOxyEntry(text);
  if (next !== null) await atomicWrite(path, next);
  return !options.ignoreInGit && next === null && /\.oxy/.test(text)
    ? 'The .gitignore entry was changed or belongs to you; it was left unchanged.'
    : null;
}
