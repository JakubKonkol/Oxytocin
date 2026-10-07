/**
 * Detection of runnable apps in a project folder: package.json scripts (Next.js, Vite, Angular, …), .NET projects
 * with launch settings, Python web apps (Django, FastAPI, Flask, Streamlit), Go, Rust, Java (Spring Boot), PHP
 * (Laravel), Ruby (Rails), Deno tasks, Docker Compose and Makefile targets. Pure logic over a small file system
 * facade so it is unit-testable.
 */

import type { RunnerKind } from '../shared/types';

export type { RunnerKind };

/** A detected (or user-defined) way to start an app. */
export interface DetectedProfile {
  /** Stable across scans: `<kind>:<folder>[:<variant>]`. */
  id: string;
  name: string;
  command: string;
  /** Folder relative to the project root, `/` separators, `''` for the root. */
  cwd: string;
  kind: RunnerKind;
  /** e.g. "Next.js", "ASP.NET Core", "Django". */
  framework?: string;
  /** Where the app is expected to answer (launch settings, framework default); the runner reports the real one. */
  url?: string;
}

export interface DetectEntry {
  name: string;
  dir: boolean;
}

/** Read-only view of the project folder (paths relative to the root, `/` separators). */
export interface DetectFs {
  list(rel: string): Promise<DetectEntry[]>;
  readText(rel: string): Promise<string | null>;
}

export interface DetectOptions {
  platform: NodeJS.Platform;
  /** Folder depth below the root that is searched (default 3). */
  maxDepth?: number;
  /** Stop after visiting this many folders (default 400). */
  maxDirs?: number;
  /** Name for apps in the project root that have no name of their own (default "app"). */
  rootName?: string;
}

/** Folders that hold dependencies, build output or caches: never searched. */
export const SKIPPED_DIRS = new Set([
  'node_modules',
  'bin',
  'obj',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'coverage',
  '__pycache__',
  'venv',
  'env',
  'site-packages',
  'bower_components',
  'packages-cache',
]);

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const baseName = (rel: string) => rel.split('/').at(-1) ?? rel;
const localUrl = (port: number, https = false) => `${https ? 'https' : 'http'}://localhost:${port}`;

/** JSON with comments and trailing commas (launchSettings.json, deno.jsonc, tsconfig-like files). */
export function parseJsonLoose(text: string): unknown {
  const stripped = text
    .replace(/^\uFEFF/, '')
    .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str: string | undefined) => str ?? '')
    .replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

// ── Node.js ──────────────────────────────────────────────────────────────────────────────────────────────────

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: unknown;
  packageManager?: string;
}

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

interface Framework {
  name: string;
  port?: number;
}

/** The web framework of a package from its dependencies (first match wins). */
export function nodeFramework(pkg: PackageJson): Framework | undefined {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const has = (name: string) => name in deps;
  const hasPrefix = (prefix: string) => Object.keys(deps).some((d) => d.startsWith(prefix));
  if (has('next')) return { name: 'Next.js', port: 3000 };
  if (has('nuxt') || has('nuxt3')) return { name: 'Nuxt', port: 3000 };
  if (has('@angular/core')) return { name: 'Angular', port: 4200 };
  if (has('@sveltejs/kit')) return { name: 'SvelteKit', port: 5173 };
  if (has('astro')) return { name: 'Astro', port: 4321 };
  if (hasPrefix('@remix-run/')) return { name: 'Remix', port: 5173 };
  if (has('gatsby')) return { name: 'Gatsby', port: 8000 };
  if (has('@docusaurus/core')) return { name: 'Docusaurus', port: 3000 };
  if (has('expo')) return { name: 'Expo', port: 8081 };
  if (has('react-scripts')) return { name: 'Create React App', port: 3000 };
  if (has('@nestjs/core')) return { name: 'NestJS', port: 3000 };
  if (has('electron')) return { name: 'Electron' };
  if (has('vite')) {
    const flavour = has('react')
      ? 'React'
      : has('vue')
        ? 'Vue'
        : has('svelte')
          ? 'Svelte'
          : has('solid-js')
            ? 'Solid'
            : '';
    return { name: flavour ? `${flavour} + Vite` : 'Vite', port: 5173 };
  }
  if (has('@vue/cli-service')) return { name: 'Vue CLI', port: 8080 };
  if (has('express') || has('fastify') || has('koa') || has('hono') || has('@hapi/hapi'))
    return { name: 'Node.js server' };
  return undefined;
}

const DEV_SCRIPTS = ['dev', 'start:dev', 'develop', 'start', 'serve', 'watch'];

/** The script that starts the app in development (`dev` before `start`, …). */
export function pickScript(scripts: Record<string, string>): string | undefined {
  return DEV_SCRIPTS.find((s) => typeof scripts[s] === 'string' && scripts[s].trim() !== '');
}

export function scriptCommand(pm: PackageManager, script: string): string {
  switch (pm) {
    case 'pnpm':
      return `pnpm run ${script}`;
    case 'yarn':
      return `yarn ${script}`;
    case 'bun':
      return `bun run ${script}`;
    default:
      return script === 'start' ? 'npm start' : `npm run ${script}`;
  }
}

async function packageManager(fs: DetectFs, dir: string, pkg: PackageJson): Promise<PackageManager> {
  const declared = /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager ?? '')?.[1] as PackageManager | undefined;
  if (declared) return declared;
  // The lock file may sit in a monorepo root above the package.
  const parts = dir ? dir.split('/') : [];
  for (let i = parts.length; i >= 0; i--) {
    const folder = parts.slice(0, i).join('/');
    const names = new Set((await fs.list(folder)).map((e) => e.name));
    if (names.has('pnpm-lock.yaml')) return 'pnpm';
    if (names.has('yarn.lock')) return 'yarn';
    if (names.has('bun.lockb') || names.has('bun.lock')) return 'bun';
    if (names.has('package-lock.json')) return 'npm';
    if (i > 0) {
      const parent = parseJsonLoose((await fs.readText(join(parts.slice(0, i - 1).join('/'), 'package.json'))) ?? '');
      const parentDeclared = /^(npm|pnpm|yarn|bun)@/.exec((parent as PackageJson | null)?.packageManager ?? '')?.[1];
      if (parentDeclared) return parentDeclared as PackageManager;
    }
  }
  return 'npm';
}

async function detectNode(fs: DetectFs, dir: string): Promise<DetectedProfile[]> {
  const pkg = parseJsonLoose((await fs.readText(join(dir, 'package.json'))) ?? '') as PackageJson | null;
  if (!pkg || typeof pkg !== 'object') return [];
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const script = pickScript(scripts);
  const out: DetectedProfile[] = [];
  const name = (typeof pkg.name === 'string' && pkg.name.replace(/^@[^/]+\//, '')) || baseName(dir) || 'app';
  const pm = script || scripts['storybook'] ? await packageManager(fs, dir, pkg) : 'npm';
  if (script) {
    const framework = nodeFramework(pkg);
    out.push({
      id: `node:${dir}`,
      name,
      command: scriptCommand(pm, script),
      cwd: dir,
      kind: 'node',
      ...(framework ? { framework: framework.name } : {}),
      ...(framework?.port ? { url: localUrl(framework.port) } : {}),
    });
  }
  if (scripts['storybook'])
    out.push({
      id: `node:${dir}:storybook`,
      name: `${name} Storybook`,
      command: scriptCommand(pm, 'storybook'),
      cwd: dir,
      kind: 'node',
      framework: 'Storybook',
      url: localUrl(6006),
    });
  return out;
}

async function detectDeno(fs: DetectFs, dir: string, file: string): Promise<DetectedProfile[]> {
  const config = parseJsonLoose((await fs.readText(join(dir, file))) ?? '') as {
    tasks?: Record<string, unknown>;
  } | null;
  const tasks = config?.tasks && typeof config.tasks === 'object' ? config.tasks : {};
  const task = ['dev', 'start', 'serve'].find((t) => t in tasks);
  if (!task) return [];
  return [
    {
      id: `deno:${dir}`,
      name: baseName(dir) || 'app',
      command: `deno task ${task}`,
      cwd: dir,
      kind: 'deno',
      framework: 'Deno',
    },
  ];
}

// ── .NET ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface LaunchProfile {
  name: string;
  url?: string;
}

/** `Project` profiles of Properties/launchSettings.json with their first URL (https preferred). */
export function parseLaunchSettings(text: string): LaunchProfile[] {
  const json = parseJsonLoose(text) as { profiles?: Record<string, { commandName?: string; applicationUrl?: string }> };
  const profiles = json?.profiles && typeof json.profiles === 'object' ? json.profiles : {};
  return Object.entries(profiles)
    .filter(([, p]) => p && p.commandName === 'Project')
    .map(([name, p]) => {
      const urls = (p.applicationUrl ?? '')
        .split(';')
        .map((u) => u.trim())
        .filter(Boolean);
      const url = urls.find((u) => u.startsWith('https:')) ?? urls[0];
      return { name, ...(url ? { url: url.replace(/\/\/(\*|\+|0\.0\.0\.0)(?=[:/]|$)/, '//localhost') } : {}) };
    });
}

/** What a project file builds: a web app, a worker, an executable — or nothing runnable (library, tests). */
export function dotnetProjectKind(xml: string, fileName: string): string | null {
  const sdk = /<Project\b[^>]*\bSdk="([^"]+)"/i.exec(xml)?.[1] ?? '';
  if (/<IsTestProject>\s*true\s*</i.test(xml) || /Microsoft\.NET\.Test\.Sdk/i.test(xml)) return null;
  if (/\.Tests?\.(cs|fs|vb)proj$/i.test(fileName)) return null;
  if (/<IsAspireHost>\s*true\s*</i.test(xml) || /Aspire\.AppHost\.Sdk/i.test(xml)) return 'Aspire AppHost';
  if (/BlazorWebAssembly/i.test(sdk)) return 'Blazor WebAssembly';
  if (/Microsoft\.NET\.Sdk\.Web/i.test(sdk)) return 'ASP.NET Core';
  if (/Microsoft\.NET\.Sdk\.Worker/i.test(sdk)) return 'Worker Service';
  if (/<OutputType>\s*(Exe|WinExe)\s*</i.test(xml))
    return /WinExe/i.test(xml) ? '.NET desktop app' : '.NET console app';
  return null;
}

async function detectDotnet(fs: DetectFs, dir: string, file: string): Promise<DetectedProfile[]> {
  const xml = await fs.readText(join(dir, file));
  if (!xml) return [];
  const framework = dotnetProjectKind(xml, file);
  if (!framework) return [];
  const launch = parseLaunchSettings((await fs.readText(join(dir, 'Properties/launchSettings.json'))) ?? '');
  const name = file.replace(/\.(cs|fs|vb)proj$/i, '');
  const first = launch[0];
  return [
    {
      id: `dotnet:${join(dir, file)}`,
      name,
      // `dotnet run` uses the first launch profile, like Visual Studio.
      command: 'dotnet run',
      cwd: dir,
      kind: 'dotnet',
      framework,
      ...(first?.url ? { url: first.url } : {}),
    },
  ];
}

// ── Python ───────────────────────────────────────────────────────────────────────────────────────────────────

/** How Python is invoked in a folder: uv/poetry/pdm, a virtual environment, or the interpreter on PATH. */
async function pythonLauncher(fs: DetectFs, dir: string, root: DetectEntry[], platform: NodeJS.Platform) {
  const names = new Set(root.map((e) => e.name));
  if (names.has('uv.lock')) return 'uv run python';
  if (names.has('poetry.lock')) return 'poetry run python';
  if (names.has('pdm.lock')) return 'pdm run python';
  for (const venv of ['.venv', 'venv', 'env']) {
    if (!names.has(venv)) continue;
    if ((await fs.readText(join(dir, `${venv}/pyvenv.cfg`))) === null) continue;
    return platform === 'win32' ? `.\\${venv}\\Scripts\\python.exe` : `${venv}/bin/python`;
  }
  return platform === 'win32' ? 'python' : 'python3';
}

const moduleName = (rel: string) => rel.replace(/\.py$/, '').split('/').join('.');

async function detectPython(
  fs: DetectFs,
  dir: string,
  entries: DetectEntry[],
  platform: NodeJS.Platform,
): Promise<DetectedProfile[]> {
  const names = new Set(entries.map((e) => e.name));
  const py = () => pythonLauncher(fs, dir, entries, platform);
  const base = { cwd: dir, kind: 'python' as const };
  const label = baseName(dir) || 'app';
  if (names.has('manage.py')) {
    return [
      {
        ...base,
        id: `python:${dir}:django`,
        name: label,
        command: `${await py()} manage.py runserver`,
        framework: 'Django',
        url: localUrl(8000),
      },
    ];
  }
  const candidates = ['main.py', 'app.py', 'server.py', 'api.py', 'app/main.py', 'src/main.py', 'streamlit_app.py'];
  for (const file of candidates) {
    const top = file.split('/')[0]!;
    if (!names.has(top)) continue;
    const source = await fs.readText(join(dir, file));
    if (!source) continue;
    const fastapi = /^(\w+)\s*(?::[^=]+)?=\s*FastAPI\(/m.exec(source);
    if (fastapi)
      return [
        {
          ...base,
          id: `python:${dir}:fastapi`,
          name: label,
          command: `${await py()} -m uvicorn ${moduleName(file)}:${fastapi[1]} --reload`,
          framework: 'FastAPI',
          url: localUrl(8000),
        },
      ];
    if (/\bFlask\(\s*__name__/.test(source))
      return [
        {
          ...base,
          id: `python:${dir}:flask`,
          name: label,
          command: `${await py()} -m flask --app ${moduleName(file)} run --debug`,
          framework: 'Flask',
          url: localUrl(5000),
        },
      ];
    if (/^\s*import streamlit\b|^\s*from streamlit\b/m.test(source))
      return [
        {
          ...base,
          id: `python:${dir}:streamlit`,
          name: label,
          command: `${await py()} -m streamlit run ${file}`,
          framework: 'Streamlit',
          url: localUrl(8501),
        },
      ];
    if (/if\s+__name__\s*==\s*['"]__main__['"]/.test(source) && !file.includes('/'))
      return [
        {
          ...base,
          id: `python:${dir}:${file}`,
          name: label,
          command: `${await py()} ${file}`,
          framework: 'Python',
        },
      ];
  }
  return [];
}

// ── Go, Rust, Java, PHP, Ruby, Compose, Make ─────────────────────────────────────────────────────────────────

async function detectGo(fs: DetectFs, dir: string, names: Set<string>): Promise<DetectedProfile[]> {
  const base = { kind: 'go' as const, framework: 'Go', cwd: dir };
  if (names.has('main.go')) return [{ ...base, id: `go:${dir}`, name: baseName(dir) || 'app', command: 'go run .' }];
  if (!names.has('cmd')) return [];
  const out: DetectedProfile[] = [];
  for (const e of await fs.list(join(dir, 'cmd'))) {
    if (!e.dir) continue;
    if (!(await fs.list(join(dir, `cmd/${e.name}`))).some((f) => f.name === 'main.go')) continue;
    out.push({ ...base, id: `go:${dir}:${e.name}`, name: e.name, command: `go run ./cmd/${e.name}` });
  }
  return out;
}

async function detectRust(fs: DetectFs, dir: string): Promise<DetectedProfile[]> {
  const toml = (await fs.readText(join(dir, 'Cargo.toml'))) ?? '';
  if (!/^\[package\]/m.test(toml)) return [];
  const hasMain = (await fs.readText(join(dir, 'src/main.rs'))) !== null || /^\[\[bin\]\]/m.test(toml);
  if (!hasMain) return [];
  const name = /^name\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? (baseName(dir) || 'app');
  return [{ id: `rust:${dir}`, name, command: 'cargo run', cwd: dir, kind: 'rust', framework: 'Rust' }];
}

async function detectJava(
  fs: DetectFs,
  dir: string,
  names: Set<string>,
  platform: NodeJS.Platform,
): Promise<DetectedProfile[]> {
  const win = platform === 'win32';
  const base = { cwd: dir, kind: 'java' as const, name: baseName(dir) || 'app' };
  if (names.has('pom.xml')) {
    const pom = (await fs.readText(join(dir, 'pom.xml'))) ?? '';
    if (!/spring-boot/.test(pom)) return [];
    const mvn = names.has('mvnw') || names.has('mvnw.cmd') ? (win ? '.\\mvnw.cmd' : './mvnw') : 'mvn';
    return [
      {
        ...base,
        id: `java:${dir}:maven`,
        command: `${mvn} spring-boot:run`,
        framework: 'Spring Boot',
        url: localUrl(8080),
      },
    ];
  }
  const gradleFile = ['build.gradle.kts', 'build.gradle'].find((f) => names.has(f));
  if (!gradleFile) return [];
  const gradle = (await fs.readText(join(dir, gradleFile))) ?? '';
  const wrapper = names.has('gradlew') || names.has('gradlew.bat') ? (win ? '.\\gradlew.bat' : './gradlew') : 'gradle';
  if (/org\.springframework\.boot/.test(gradle))
    return [
      {
        ...base,
        id: `java:${dir}:gradle`,
        command: `${wrapper} bootRun`,
        framework: 'Spring Boot',
        url: localUrl(8080),
      },
    ];
  if (/\bapplication\b/.test(gradle) && /mainClass/.test(gradle))
    return [{ ...base, id: `java:${dir}:gradle`, command: `${wrapper} run`, framework: 'Gradle application' }];
  return [];
}

function detectSimple(dir: string, names: Set<string>, platform: NodeJS.Platform): DetectedProfile[] {
  const out: DetectedProfile[] = [];
  const label = baseName(dir) || 'app';
  if (names.has('artisan'))
    out.push({
      id: `php:${dir}:laravel`,
      name: label,
      command: 'php artisan serve',
      cwd: dir,
      kind: 'php',
      framework: 'Laravel',
      url: localUrl(8000),
    });
  if (names.has('bin') && names.has('Gemfile') && names.has('config.ru'))
    out.push({
      id: `ruby:${dir}:rails`,
      name: label,
      command: platform === 'win32' ? 'ruby bin\\rails server' : 'bin/rails server',
      cwd: dir,
      kind: 'ruby',
      framework: 'Rails',
      url: localUrl(3000),
    });
  const compose = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'].find((f) =>
    names.has(f),
  );
  if (compose)
    out.push({
      id: `docker:${dir}`,
      name: `${label} (Docker Compose)`,
      command: compose.startsWith('compose.') ? 'docker compose up' : `docker compose -f ${compose} up`,
      cwd: dir,
      kind: 'docker',
      framework: 'Docker Compose',
    });
  return out;
}

async function detectMake(fs: DetectFs, dir: string): Promise<DetectedProfile[]> {
  const makefile = (await fs.readText(join(dir, 'Makefile'))) ?? '';
  const target = ['dev', 'run', 'serve', 'start'].find((t) => new RegExp(`^${t}\\s*:(?!=)`, 'm').test(makefile));
  if (!target) return [];
  return [
    {
      id: `make:${dir}:${target}`,
      name: `make ${target}`,
      command: `make ${target}`,
      cwd: dir,
      kind: 'make',
      framework: 'Makefile',
    },
  ];
}

// ── Walk ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Apps found in one folder. */
async function detectFolder(
  fs: DetectFs,
  dir: string,
  entries: DetectEntry[],
  platform: NodeJS.Platform,
): Promise<DetectedProfile[]> {
  const files = entries.filter((e) => !e.dir).map((e) => e.name);
  const names = new Set(entries.map((e) => e.name));
  const out: DetectedProfile[] = [];
  if (names.has('package.json')) out.push(...(await detectNode(fs, dir)));
  for (const deno of ['deno.json', 'deno.jsonc'])
    if (names.has(deno) && !names.has('package.json')) out.push(...(await detectDeno(fs, dir, deno)));
  for (const f of files.filter((f) => /\.(cs|fs|vb)proj$/i.test(f))) out.push(...(await detectDotnet(fs, dir, f)));
  if (
    ['manage.py', 'pyproject.toml', 'requirements.txt', 'main.py', 'app.py', 'streamlit_app.py'].some((f) =>
      names.has(f),
    )
  )
    out.push(...(await detectPython(fs, dir, entries, platform)));
  if (names.has('go.mod')) out.push(...(await detectGo(fs, dir, names)));
  if (names.has('Cargo.toml')) out.push(...(await detectRust(fs, dir)));
  out.push(...(await detectJava(fs, dir, names, platform)));
  out.push(...detectSimple(dir, names, platform));
  if (dir === '' && names.has('Makefile')) out.push(...(await detectMake(fs, dir)));
  return out;
}

/** Runnable apps of a project, breadth-first (the root first), without duplicates. */
export async function detectProfiles(fs: DetectFs, opts: DetectOptions): Promise<DetectedProfile[]> {
  const maxDepth = opts.maxDepth ?? 3;
  const maxDirs = opts.maxDirs ?? 400;
  const out: DetectedProfile[] = [];
  const seen = new Set<string>();
  let level = [''];
  let visited = 0;
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      if (++visited > maxDirs) return out;
      const entries = await fs.list(dir);
      for (const p of await detectFolder(fs, dir, entries, opts.platform)) {
        if (seen.has(p.id)) continue;
        if (dir === '' && opts.rootName) p.name = p.name.replace(/^app(?= |$)/, opts.rootName);
        seen.add(p.id);
        out.push(p);
      }
      for (const e of entries) {
        if (!e.dir || e.name.startsWith('.') || SKIPPED_DIRS.has(e.name.toLowerCase())) continue;
        next.push(join(dir, e.name));
      }
    }
    level = next.sort();
  }
  return out;
}
