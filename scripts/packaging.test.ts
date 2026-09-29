import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const RUNTIME_DIRS = ['src/main', 'src/preload', 'src/pty-host', 'src/workspace-host', 'src/plugin-host', 'src/shared'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
  });
}

/** Package names imported (statically or dynamically, not type-only) by code that runs outside the renderer. */
function runtimeImports(): Set<string> {
  const names = new Set<string>();
  const re =
    /(?:^|\n)\s*import\s+(?!type\s)[^'"]*?from\s+['"]([^'"./][^'"]*)['"]|import\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g;
  for (const dir of RUNTIME_DIRS)
    for (const file of files(join(root, dir))) {
      for (const m of readFileSync(file, 'utf8').matchAll(re)) {
        const spec = (m[1] ?? m[2])!;
        if (spec.startsWith('node:') || spec.startsWith('@shared/') || spec === 'electron') continue;
        names.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);
      }
    }
  return names;
}

function closure(names: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...names];
  while (stack.length) {
    const name = stack.pop()!;
    if (seen.has(name)) continue;
    let pkg: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')) as typeof pkg;
    } catch {
      continue; // optional platform packages of other systems
    }
    seen.add(name);
    stack.push(...Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }));
  }
  return seen;
}

/** `node_modules/{a,b}/**` patterns of electron-builder.yml → matchers for package names. */
function packagedPatterns(): RegExp[] {
  const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
  const out: RegExp[] = [];
  for (const m of yml.matchAll(/^\s*-\s*'?node_modules\/(.+?)\/\*\*'?\s*$/gm)) {
    const pattern = m[1]!;
    const expand = (p: string): string[] => {
      const b = /\{([^}]+)\}/.exec(p);
      return b ? b[1]!.split(',').flatMap((alt) => expand(p.replace(b[0], alt))) : [p];
    };
    for (const p of expand(pattern))
      out.push(new RegExp(`^${p.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
  }
  return out;
}

describe('packaging', () => {
  it('ships every module main and the hosts load at runtime, with their dependencies', () => {
    const imports = runtimeImports();
    expect(imports.size).toBeGreaterThan(5);
    const patterns = packagedPatterns();
    const missing = [...closure(imports)].filter((name) => !patterns.some((p) => p.test(name)));
    expect(missing).toEqual([]);
  });
});

describe('README', () => {
  it('shows the current version in its release badge (bumped by .github/scripts/prepare-release.sh)', () => {
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    const badge = /img\.shields\.io\/badge\/release-v(\d+\.\d+\.\d+)-/.exec(
      readFileSync(join(root, 'README.md'), 'utf8'),
    );
    expect(badge).not.toBeNull();
    // Pre-releases are not "latest": the badge keeps the last stable version.
    if (!version.includes('-')) expect(badge![1]).toBe(version);
  });
});
