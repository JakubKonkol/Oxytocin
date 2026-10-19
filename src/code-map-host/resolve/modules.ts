import { posix } from 'node:path';
import type { FileRecord } from '../extract/record';
import type { PackageConfig, ProjectConfig } from './config';

export type ModuleTarget =
  { kind: 'file'; path: string } | { kind: 'package'; name: string } | { kind: 'unresolved'; reason: string };
interface CompilerOptions {
  baseUrl?: string;
  paths?: { values: Record<string, string[]>; origin: string };
}
const extensions = ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const contained = (path: string) =>
  path !== '..' && !path.startsWith('../') && !path.startsWith('/') && !/^[a-z]:/i.test(path);
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return (value as unknown[]).flatMap(strings);
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    return ['types', 'source', 'import', 'require', 'default'].flatMap((condition) => strings(object[condition]));
  }
  return [];
}
export function packageName(specifier: string): string {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!;
}

/** Resolves against the indexed snapshot only. It cannot read an excluded or external file. */
export class ModuleResolver {
  private readonly packages = new Map<string, { directory: string; config: PackageConfig }>();
  private readonly duplicatePackages = new Set<string>();
  private readonly compiler = new Map<string, CompilerOptions>();
  constructor(
    readonly records: ReadonlyMap<string, FileRecord>,
    readonly configs: ReadonlyMap<string, ProjectConfig>,
  ) {
    const root = configs.get('package.json');
    const workspaces = root?.kind === 'package' ? root.data.workspaces : undefined;
    const patterns = Array.isArray(workspaces) ? workspaces : (workspaces?.packages ?? []);
    for (const [path, config] of [...configs].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
      if (config.kind !== 'package' || !config.data.name) continue;
      const directory = posix.dirname(path);
      if (directory === '.' || patterns.some((pattern) => posix.matchesGlob(directory, pattern.replace(/\/$/, '')))) {
        if (this.packages.has(config.data.name)) {
          this.packages.delete(config.data.name);
          this.duplicatePackages.add(config.data.name);
        } else if (!this.duplicatePackages.has(config.data.name))
          this.packages.set(config.data.name, { directory, config: config.data });
      }
    }
  }
  private lookup(candidate: string, seen = new Set<string>()): string | null {
    candidate = posix.normalize(candidate);
    if (!contained(candidate) || seen.has(candidate)) return null;
    seen.add(candidate);
    const substitutions = candidate.endsWith('.js')
      ? ['.ts', '.tsx', '.d.ts', '.js', '.jsx'].map((extension) => candidate.slice(0, -3) + extension)
      : candidate.endsWith('.mjs')
        ? ['.mts', '.d.mts', '.mjs'].map((extension) => candidate.slice(0, -4) + extension)
        : candidate.endsWith('.cjs')
          ? ['.cts', '.d.cts', '.cjs'].map((extension) => candidate.slice(0, -4) + extension)
          : [candidate, ...extensions.map((extension) => candidate + extension)];
    for (const path of substitutions) if (this.records.has(path)) return path;
    const config = this.configs.get(posix.join(candidate, 'package.json'));
    if (config?.kind === 'package')
      for (const entry of [
        ...strings(config.data.exports),
        config.data.types,
        config.data.typings,
        config.data.main,
      ].filter((value): value is string => !!value)) {
        const result = this.lookup(posix.join(candidate, entry), seen);
        if (result) return result;
      }
    for (const extension of extensions) {
      const path = posix.join(candidate, `index${extension}`);
      if (this.records.has(path)) return path;
    }
    return null;
  }
  private configPath(path: string): string | null {
    for (let directory = posix.dirname(path); ; directory = posix.dirname(directory)) {
      for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const candidate = posix.join(directory, name);
        if (this.configs.get(candidate)?.kind === 'typescript') return candidate;
      }
      if (directory === '.') return null;
    }
  }
  private compilerOptions(path: string, visiting = new Set<string>()): CompilerOptions {
    const cached = this.compiler.get(path);
    if (cached) return cached;
    if (visiting.has(path)) return {};
    visiting.add(path);
    const config = this.configs.get(path);
    if (config?.kind !== 'typescript') return {};
    let output: CompilerOptions = {};
    for (const base of typeof config.data.extends === 'string' ? [config.data.extends] : (config.data.extends ?? [])) {
      let candidate = posix.normalize(posix.join(posix.dirname(path), base));
      if (!candidate.endsWith('.json')) candidate += '.json';
      if (!base.startsWith('.')) {
        const workspace = this.packages.get(packageName(base));
        if (!workspace) continue;
        candidate = posix.join(workspace.directory, base.slice(packageName(base).length) || 'tsconfig.json');
      }
      if (contained(candidate)) output = { ...output, ...this.compilerOptions(candidate, new Set(visiting)) };
    }
    const options = config.data.compilerOptions;
    if (options?.baseUrl !== undefined)
      output.baseUrl = posix.normalize(posix.join(posix.dirname(path), options.baseUrl));
    if (options?.paths) output.paths = { values: options.paths, origin: posix.dirname(path) };
    this.compiler.set(path, output);
    return output;
  }
  resolve(from: string, specifier: string | null): ModuleTarget {
    if (specifier === null) return { kind: 'unresolved', reason: 'dynamic-module-specifier' };
    if (specifier.startsWith('/') || /^[a-z]:/i.test(specifier))
      return { kind: 'unresolved', reason: 'absolute-module-specifier' };
    if (specifier.startsWith('.')) {
      const path = this.lookup(posix.join(posix.dirname(from), specifier));
      return path ? { kind: 'file', path } : { kind: 'unresolved', reason: 'relative-module-not-indexed' };
    }
    const config = this.configPath(from);
    const compiler = config ? this.compilerOptions(config) : {};
    const patterns = Object.entries(compiler.paths?.values ?? {}).sort(
      ([left], [right]) =>
        right.replace('*', '').length - left.replace('*', '').length || (left < right ? -1 : left > right ? 1 : 0),
    );
    for (const [pattern, targets] of patterns) {
      const star = pattern.indexOf('*');
      const match =
        star < 0
          ? specifier === pattern
          : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1));
      if (!match) continue;
      const replacement = star < 0 ? '' : specifier.slice(star, specifier.length - (pattern.length - star - 1));
      for (const entry of targets) {
        const path = this.lookup(
          posix.join(compiler.baseUrl ?? compiler.paths!.origin, entry.replace('*', replacement)),
        );
        if (path) return { kind: 'file', path };
      }
      return { kind: 'unresolved', reason: 'path-mapping-target-not-indexed' };
    }
    if (compiler.baseUrl) {
      const path = this.lookup(posix.join(compiler.baseUrl, specifier));
      if (path) return { kind: 'file', path };
    }
    const name = packageName(specifier);
    if (this.duplicatePackages.has(name)) return { kind: 'unresolved', reason: 'ambiguous-workspace-package' };
    const workspace = this.packages.get(name);
    if (!workspace) return { kind: 'package', name };
    const subpath = specifier.slice(name.length).replace(/^\//, '');
    const exports = workspace.config.exports;
    let candidates: string[] = [];
    if (exports && typeof exports === 'object' && !Array.isArray(exports)) {
      const key = subpath ? `./${subpath}` : '.';
      const mapping = exports as Record<string, unknown>;
      candidates = strings(mapping[key]);
      for (const [pattern, value] of Object.entries(mapping)) {
        const star = pattern.indexOf('*');
        if (star >= 0 && key.startsWith(pattern.slice(0, star)) && key.endsWith(pattern.slice(star + 1)))
          candidates.push(
            ...strings(value).map((entry) =>
              entry.replace('*', key.slice(star, key.length - (pattern.length - star - 1))),
            ),
          );
      }
      if (!subpath && !Object.keys(mapping).some((key) => key.startsWith('.'))) candidates = strings(exports);
    } else if (!subpath) candidates = strings(exports);
    if (!candidates.length && exports !== undefined)
      return { kind: 'unresolved', reason: 'workspace-subpath-not-exported' };
    if (!candidates.length)
      candidates = subpath
        ? [subpath]
        : [workspace.config.types, workspace.config.typings, workspace.config.main, 'index'].filter(
            (value): value is string => !!value,
          );
    for (const candidate of candidates) {
      const path = this.lookup(posix.join(workspace.directory, candidate));
      if (path) return { kind: 'file', path };
    }
    return { kind: 'unresolved', reason: 'workspace-entry-not-indexed' };
  }
}
