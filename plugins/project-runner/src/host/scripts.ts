/**
 * Custom scripts: an existing script file of the project (`.bat`, `.cmd`, `.ps1`, `.sh`, …) or a script written in
 * the Run tool, run in a terminal like any other profile. Pure helpers (paths, the command line that runs a script,
 * the scripts of a project) so they are unit-testable.
 */

import { posix, win32 } from 'node:path';
import { type DetectFs, SKIPPED_DIRS } from './detect';
import type { ScriptLanguage } from '../shared/types';

/** Extensions offered when the user picks a script file of the project. */
export const SCRIPT_EXTENSIONS = ['.bat', '.cmd', '.ps1', '.sh', '.bash', '.zsh', '.command'];

export const SCRIPT_LANGUAGES: readonly ScriptLanguage[] = ['cmd', 'powershell', 'sh'];

/** A written script's language when none was chosen: batch on Windows, sh elsewhere. */
export const defaultLanguage = (platform: NodeJS.Platform): ScriptLanguage => (platform === 'win32' ? 'cmd' : 'sh');

const EXTENSION: Record<ScriptLanguage, string> = { cmd: '.cmd', powershell: '.ps1', sh: '.sh' };

/** File name of a written script (saved in the plugin's project folder). */
export const inlineFileName = (profileId: string, language: ScriptLanguage) =>
  `${profileId.replace(/[^\w.-]/g, '_')}${EXTENSION[language]}`;

/**
 * The file content of a written script: CRLF line breaks for batch files (cmd misreads labels and `goto` in LF
 * files) and a BOM for PowerShell (Windows PowerShell 5 reads a file without one in the ANSI code page).
 */
export function inlineFileText(text: string, language: ScriptLanguage): string {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n*$/, '\n');
  if (language === 'cmd') return lines.replace(/\n/g, '\r\n');
  if (language === 'powershell') return `\uFEFF${lines}`;
  return lines;
}

const pathOf = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);

/** Whether `path` is absolute on `platform` (`C:\…`, `\\server\…` on Windows; `/…` elsewhere). */
export const isAbsolutePath = (path: string, platform: NodeJS.Platform) => pathOf(platform).isAbsolute(path);

/**
 * A script file as stored: relative to the project root with `/` separators when it lies inside the project (also
 * when given as an absolute path), otherwise absolute. Throws a readable error for an empty path.
 */
export function normalizeScriptFile(input: string, rootPath: string, platform: NodeJS.Platform): string {
  const raw = input
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .replace(/^'(.*)'$/, '$1');
  if (!raw) throw new Error('Choose a script file.');
  const path = pathOf(platform);
  const absolute = path.resolve(rootPath, platform === 'win32' ? raw.replace(/\//g, '\\') : raw);
  const rel = path.relative(rootPath, absolute);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  if (!rel) throw new Error('Choose a script file, not the project folder.');
  return absolute;
}

/** Absolute path of a stored script file. */
export function scriptFilePath(file: string, rootPath: string, platform: NodeJS.Platform): string {
  const path = pathOf(platform);
  return isAbsolutePath(file, platform) ? file : path.join(rootPath, ...file.split('/'));
}

/** The folder of a stored script file relative to the project root (`''` for the root or a file outside it). */
export function scriptFolder(file: string, platform: NodeJS.Platform): string {
  if (isAbsolutePath(file, platform)) return '';
  return file.split('/').slice(0, -1).join('/');
}

const quote = (path: string, platform: NodeJS.Platform) =>
  platform === 'win32' ? `"${path}"` : `'${path.replace(/'/g, `'\\''`)}'`;

/**
 * The command line that runs a script file, typed into the profile's terminal (PowerShell or cmd on Windows, a
 * POSIX shell elsewhere). Batch files run through `cmd /c`, so `PAUSE` and `Terminate batch job (Y/N)?` work the
 * same in every shell; PowerShell scripts bypass the execution policy like a double click in Explorer would ask.
 * `path` is relative to the terminal's folder or absolute.
 */
export function scriptCommand(path: string, platform: NodeJS.Platform): string {
  const win = platform === 'win32';
  const native = win ? path.replace(/\//g, '\\') : path;
  const ext = pathOf(platform).extname(native).toLowerCase();
  const q = quote(native, platform);
  switch (ext) {
    case '.bat':
    case '.cmd':
      return `cmd /c ${q}`;
    case '.ps1':
      return win ? `powershell -NoProfile -ExecutionPolicy Bypass -File ${q}` : `pwsh -NoProfile -File ${q}`;
    case '.sh':
    case '.bash':
    case '.command':
      return `bash ${q}`;
    case '.zsh':
      return `zsh ${q}`;
    case '.py':
      return `${win ? 'python' : 'python3'} ${q}`;
    case '.js':
    case '.mjs':
    case '.cjs':
      return `node ${q}`;
    default:
      // An executable (or a file Windows opens with its associated program).
      if (win) return `cmd /c ${q}`;
      return quote(native.includes('/') ? native : `./${native}`, platform);
  }
}

/** The command that runs a stored script file from the profile's folder (relative when the file is in the project). */
export function fileScriptCommand(file: string, cwd: string, platform: NodeJS.Platform): string {
  return scriptCommand(isAbsolutePath(file, platform) ? file : posix.relative(cwd, file), platform);
}

/** Script files of a project (breadth-first, the root first), for picking one. */
export async function findScripts(fs: DetectFs, opts: { maxDepth?: number; limit?: number } = {}): Promise<string[]> {
  const maxDepth = opts.maxDepth ?? 4;
  const limit = opts.limit ?? 500;
  const out: string[] = [];
  let level = [''];
  let visited = 0;
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      if (++visited > 1000) return out;
      const entries = [...(await fs.list(dir))].sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.dir) {
          if (!e.name.startsWith('.') && !SKIPPED_DIRS.has(e.name.toLowerCase())) next.push(rel);
        } else if (SCRIPT_EXTENSIONS.some((ext) => e.name.toLowerCase().endsWith(ext))) {
          out.push(rel);
          if (out.length >= limit) return out;
        }
      }
    }
    level = next;
  }
  return out;
}
