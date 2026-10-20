import { execFile } from 'node:child_process';
import { lstat, open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import ignore, { type Ignore } from 'ignore';
import { CODE_MAP_LIMITS, CodeMapRelativePathSchema, type CodeMapDiagnostics } from '@shared/domain/code-map';
import { DEFAULT_IGNORED_FOLDERS } from '@shared/domain/settings';
import { hasCode, isInside } from './store/paths';

export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const BUILTIN_FOLDERS = new Set(['.git', '.oxy', ...DEFAULT_IGNORED_FOLDERS]);
export class CodeMapLimitError extends Error {
  constructor(message = 'Code Map limit reached — add exclusions') {
    super(message);
    this.name = 'CodeMapLimitError';
  }
}
export const comparePaths = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
export const toPosix = (path: string): string => path.split(sep).join('/');

export function builtInExclusion(path: string): string | null {
  const parts = path.split('/');
  if (parts.some((part) => BUILTIN_FOLDERS.has(part.toLowerCase()))) return 'generated-or-local-directory';
  const name = parts.at(-1)!.toLowerCase();
  if (
    /^(\.env|id_rsa|id_dsa|id_ecdsa|id_ed25519)/.test(name) ||
    /\.(pem|key|p12|pfx|keystore)$/.test(name) ||
    name === '.npmrc' ||
    name === '.netrc'
  )
    return 'probable-secret';
  if (
    /\.lockb?$/.test(name) ||
    ['package-lock.json', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'go.sum', 'packages.lock.json'].includes(name)
  )
    return 'lock-file';
  return null;
}

const DOTNET_PROJECT = /\.(cs|fs|vb)proj$/i;
/** `bin/` and `obj/` are build output only next to a .NET project file; elsewhere they may hold sources. */
export function dotnetOutputDirectory(path: string, projectDirectories: ReadonlySet<string>): string | null {
  const parts = path.split('/');
  const index = parts.findIndex(
    (part, index) =>
      index < parts.length - 1 &&
      ['bin', 'obj'].includes(part.toLowerCase()) &&
      projectDirectories.has(parts.slice(0, index).join('/') || '.'),
  );
  return index < 0 ? null : parts.slice(0, index + 1).join('/');
}

export function matchesExclusion(path: string, patterns: readonly string[]): boolean {
  const parts = path.split('/');
  return patterns.some((pattern) => {
    const glob = pattern.replace(/\\/g, '/').replace(/\/+$/, '');
    return glob !== '' && parts.some((_, index) => posix.matchesGlob(parts.slice(0, index + 1).join('/'), glob));
  });
}

export interface SourceMetadata {
  size: number;
  mtimeNs: string;
  inode: string;
  device: string;
}
export interface EnumeratedFile {
  path: string;
  metadata: SourceMetadata;
}
export interface Enumeration {
  root: string;
  files: EnumeratedFile[];
  diagnostics: CodeMapDiagnostics;
  skippedCount: number;
  /** Complete skip and failure reasons by path; `diagnostics` holds the bounded, sorted view. */
  skippedPaths: Map<string, string>;
  failedPaths: Map<string, string>;
  git: boolean;
}
export function metadataOf(info: Awaited<ReturnType<typeof stat>>): SourceMetadata {
  return {
    size: Number(info.size),
    mtimeNs: String('mtimeNs' in info ? info.mtimeNs : info.mtimeMs),
    inode: String(info.ino),
    device: String(info.dev),
  };
}

/** This filter runs before any content read, including the binary probe. */
export async function resolveSourcePath(root: string, path: string): Promise<string> {
  CodeMapRelativePathSchema.parse(path);
  if (builtInExclusion(path)) throw new Error('Excluded source path');
  const canonical = await realpath(join(root, ...path.split('/')));
  if (!isInside(root, canonical) || builtInExclusion(toPosix(relative(root, canonical))))
    throw new Error('Excluded or escaping source path');
  return canonical;
}

export async function enumerate(options: {
  root: string;
  gitPath: string;
  excludedPaths?: readonly string[];
  signal?: AbortSignal;
  maxFiles?: number;
  /** Limits enumeration to these paths (watcher events); the result describes only them. */
  paths?: readonly string[];
}): Promise<Enumeration> {
  const root = await realpath(options.root);
  const excluded = options.excludedPaths ?? [];
  const diagnostics: CodeMapDiagnostics = { skipped: [], failed: [], unresolved: [], truncated: false };
  let skippedCount = 0;
  const skippedPaths = new Map<string, string>();
  const failedPaths = new Map<string, string>();
  const skip = (path: string, reason: string) => {
    skippedCount++;
    skippedPaths.set(path, reason);
    if (diagnostics.skipped.length < 200) diagnostics.skipped.push({ path, reason });
    else diagnostics.truncated = true;
  };
  let git = false;
  let candidates: string[] = [];
  try {
    const result = await promisify(execFile)(
      options.gitPath,
      [
        '--no-optional-locks',
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        ...(options.paths ? ['--', ...options.paths.map((path) => `:(literal)${path}`)] : []),
      ],
      {
        cwd: root,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30_000,
        signal: options.signal,
      },
    );
    git = true;
    candidates = result.stdout.split('\0').filter(Boolean);
  } catch (error) {
    if (
      !hasCode(error, 'ENOENT') &&
      !(typeof error === 'object' && error !== null && 'code' in error && error.code === 128)
    )
      throw error;
  }

  interface IgnoreScope {
    directory: string;
    rules: Ignore;
  }
  const scopeOf = async (directory: string): Promise<IgnoreScope | null> => {
    const ignorePath = join(directory, '.gitignore');
    try {
      const info = await lstat(ignorePath);
      if (info.isFile() && !info.isSymbolicLink() && info.size <= MAX_SOURCE_BYTES)
        return { directory, rules: ignore({ ignorecase: false }).add(await readFile(ignorePath, 'utf8')) };
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
    return null;
  };
  const ignoredBy = (scopes: readonly IgnoreScope[], absolute: string, directory: boolean): boolean => {
    let ignored = false;
    for (const scope of scopes) {
      const result = scope.rules.test(`${toPosix(relative(scope.directory, absolute))}${directory ? '/' : ''}`);
      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    }
    return ignored;
  };
  const walk = async (directory: string, scopes: IgnoreScope[]): Promise<void> => {
    options.signal?.throwIfAborted();
    const own = await scopeOf(directory);
    const current = own ? [...scopes, own] : scopes;
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => comparePaths(a.name, b.name));
    const dotnet = entries.some((entry) => entry.isFile() && DOTNET_PROJECT.test(entry.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const path = toPosix(relative(root, absolute));
      if (dotnet && entry.isDirectory() && ['bin', 'obj'].includes(entry.name.toLowerCase())) {
        skip(path, 'generated-or-local-directory');
        continue;
      }
      if (builtInExclusion(path) || matchesExclusion(path, excluded)) {
        skip(path, builtInExclusion(path) ?? 'user-exclusion');
        continue;
      }
      if (ignoredBy(current, absolute, entry.isDirectory())) continue;
      if (entry.isDirectory()) {
        if (await lstat(join(absolute, '.git')).catch(() => null)) {
          skip(path, 'nested-repository');
          continue;
        }
        await walk(absolute, current);
      } else if (entry.isFile() || entry.isSymbolicLink()) candidates.push(path);
      if (candidates.length > (options.maxFiles ?? CODE_MAP_LIMITS.files)) throw new CodeMapLimitError();
    }
  };
  /** Without Git, a single path is eligible when no ancestor is excluded or ignored, as the walk would decide. */
  const eligible = async (path: string): Promise<boolean> => {
    const parts = path.split('/');
    let scopes: IgnoreScope[] = [];
    for (let index = 0; index < parts.length; index++) {
      const own = await scopeOf(join(root, ...parts.slice(0, index)));
      if (own) scopes = [...scopes, own];
      const prefix = parts.slice(0, index + 1).join('/');
      if (index < parts.length - 1 && (builtInExclusion(prefix) || matchesExclusion(prefix, excluded))) return false;
      if (ignoredBy(scopes, join(root, ...prefix.split('/')), index < parts.length - 1)) return false;
    }
    return true;
  };
  if (!git && options.paths)
    for (const path of options.paths) {
      if (await eligible(path)) candidates.push(path);
    }
  else if (!git) await walk(root, []);
  const boundaries = new Map<string, Promise<string | null>>();
  const nestedRoot = (directory: string): Promise<string | null> => {
    if (directory === root) return Promise.resolve(null);
    let result = boundaries.get(directory);
    if (!result) {
      result = (async () => {
        if (await lstat(join(directory, '.git')).catch(() => null)) return toPosix(relative(root, directory));
        return nestedRoot(dirname(directory));
      })();
      boundaries.set(directory, result);
    }
    return result;
  };
  const reportedBoundaries = new Set<string>();
  const files: EnumeratedFile[] = [];
  const projectDirectories = new Set(
    candidates.filter((path) => DOTNET_PROJECT.test(path)).map((path) => posix.dirname(path.replace(/\/$/, ''))),
  );
  if (options.paths)
    for (const path of candidates) {
      const parts = path.split('/');
      for (let index = 0; index < parts.length - 1; index++) {
        const directory = parts.slice(0, index).join('/') || '.';
        if (!['bin', 'obj'].includes(parts[index]!.toLowerCase()) || projectDirectories.has(directory)) continue;
        const names = await readdir(join(root, ...parts.slice(0, index))).catch(() => [] as string[]);
        if (names.some((name) => DOTNET_PROJECT.test(name))) projectDirectories.add(directory);
      }
    }
  const reportedOutputs = new Set<string>();
  const ordered = [...new Set(candidates)].sort(comparePaths).filter((path) => {
    const output = dotnetOutputDirectory(path, projectDirectories);
    if (output && !reportedOutputs.has(output)) {
      reportedOutputs.add(output);
      skip(output, 'generated-or-local-directory');
    }
    return !output;
  });
  for (let offset = 0; offset < ordered.length; offset += 32) {
    options.signal?.throwIfAborted();
    const batch = await Promise.all(
      ordered.slice(offset, offset + 32).map(async (candidate): Promise<EnumeratedFile | null> => {
        const path = candidate.replace(/\/$/, '');
        if (!CodeMapRelativePathSchema.safeParse(path).success) return null;
        const reason = builtInExclusion(path);
        if (reason || matchesExclusion(path, excluded)) {
          skip(path, reason ?? 'user-exclusion');
          return null;
        }
        try {
          const absolute = await resolveSourcePath(root, path);
          if (matchesExclusion(toPosix(relative(root, absolute)), excluded)) {
            skip(path, 'user-exclusion');
            return null;
          }
          const boundary = await nestedRoot((await lstat(absolute)).isDirectory() ? absolute : dirname(absolute));
          if (boundary) {
            if (!reportedBoundaries.has(boundary)) {
              reportedBoundaries.add(boundary);
              skip(boundary, 'nested-repository');
            }
            return null;
          }
          const info = await stat(absolute, { bigint: true });
          if (!info.isFile()) {
            skip(path, 'not-a-file');
            return null;
          }
          if (info.size > BigInt(MAX_SOURCE_BYTES)) {
            skip(path, 'too-large');
            return null;
          }
          const handle = await open(absolute, 'r');
          try {
            const probe = Buffer.alloc(Math.min(8192, Number(info.size)));
            const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
            if (probe.subarray(0, bytesRead).includes(0)) {
              skip(path, 'binary');
              return null;
            }
          } finally {
            await handle.close();
          }
          return { path, metadata: metadataOf(info) };
        } catch (error) {
          if (hasCode(error, 'ENOENT')) return null;
          failedPaths.set(path, error instanceof Error ? error.message : String(error));
          if (diagnostics.failed.length < 200)
            diagnostics.failed.push({ path, reason: error instanceof Error ? error.message : String(error) });
          else diagnostics.truncated = true;
          return null;
        }
      }),
    );
    for (const file of batch)
      if (file) {
        if (files.length >= (options.maxFiles ?? CODE_MAP_LIMITS.files)) throw new CodeMapLimitError();
        files.push(file);
      }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  diagnostics.skipped.sort((a, b) => comparePaths(a.path, b.path));
  diagnostics.failed.sort((a, b) => comparePaths(a.path, b.path));
  return { root, files, diagnostics, skippedCount, skippedPaths, failedPaths, git };
}
