import { describe, expect, it } from 'vitest';
import {
  type DetectFs,
  detectProfiles,
  dotnetProjectKind,
  nodeFramework,
  parseJsonLoose,
  parseLaunchSettings,
  pickScript,
} from './detect';

/** An in-memory project: `files` maps relative paths to contents (folders are implied). */
function memoryFs(files: Record<string, string>): DetectFs {
  return {
    list(rel) {
      const prefix = rel ? `${rel}/` : '';
      const out = new Map<string, boolean>();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length).split('/');
        out.set(rest[0]!, rest.length > 1 || out.get(rest[0]!) === true);
      }
      return Promise.resolve([...out].map(([name, dir]) => ({ name, dir })));
    },
    readText(rel) {
      return Promise.resolve(files[rel] ?? null);
    },
  };
}

const pkg = (o: Record<string, unknown>) => JSON.stringify(o);

describe('detectProfiles', () => {
  it('finds Node.js apps with their framework, package manager and default URL', async () => {
    const fs = memoryFs({
      'package.json': pkg({ name: 'mono', private: true, workspaces: ['apps/*'], packageManager: 'pnpm@9.1.0' }),
      'pnpm-lock.yaml': '',
      'apps/web/package.json': pkg({
        name: '@acme/web',
        scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
        dependencies: { next: '15', react: '19' },
      }),
      'apps/admin/package.json': pkg({
        name: 'admin',
        scripts: { start: 'ng serve', storybook: 'storybook dev -p 6006' },
        dependencies: { '@angular/core': '19' },
      }),
      'apps/admin/node_modules/x/package.json': pkg({ scripts: { dev: 'x' } }),
      'libs/utils/package.json': pkg({ name: 'utils', scripts: { build: 'tsc' } }),
    });
    const found = await detectProfiles(fs, { platform: 'linux' });
    expect(found).toEqual([
      {
        id: 'node:apps/admin',
        name: 'admin',
        command: 'pnpm run start',
        cwd: 'apps/admin',
        kind: 'node',
        framework: 'Angular',
        url: 'http://localhost:4200',
      },
      {
        id: 'node:apps/admin:storybook',
        name: 'admin Storybook',
        command: 'pnpm run storybook',
        cwd: 'apps/admin',
        kind: 'node',
        framework: 'Storybook',
        url: 'http://localhost:6006',
      },
      {
        id: 'node:apps/web',
        name: 'web',
        command: 'pnpm run dev',
        cwd: 'apps/web',
        kind: 'node',
        framework: 'Next.js',
        url: 'http://localhost:3000',
      },
    ]);
  });

  it('uses npm and yarn from lock files', async () => {
    const npm = await detectProfiles(
      memoryFs({
        'package.json': pkg({
          name: 'site',
          scripts: { start: 'react-scripts start' },
          dependencies: { 'react-scripts': '5' },
        }),
        'package-lock.json': '{}',
      }),
      { platform: 'win32' },
    );
    expect(npm[0]).toMatchObject({ command: 'npm start', framework: 'Create React App', cwd: '' });
    const yarn = await detectProfiles(
      memoryFs({
        'package.json': pkg({ name: 'ui', scripts: { dev: 'vite' }, devDependencies: { vite: '6', vue: '3' } }),
        'yarn.lock': '',
      }),
      { platform: 'linux' },
    );
    expect(yarn[0]).toMatchObject({ command: 'yarn dev', framework: 'Vue + Vite', url: 'http://localhost:5173' });
  });

  it('finds .NET web and console projects, skipping tests and libraries', async () => {
    const fs = memoryFs({
      'Shop.sln': '',
      'src/Shop.Api/Shop.Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup /></Project>',
      'src/Shop.Api/Properties/launchSettings.json': `{
        // comment
        "profiles": {
          "IIS Express": { "commandName": "IISExpress" },
          "https": { "commandName": "Project", "applicationUrl": "https://localhost:7043;http://localhost:5043", },
        }
      }`,
      'src/Shop.Tool/Shop.Tool.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup></Project>',
      'src/Shop.Core/Shop.Core.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
      'tests/Shop.Api.Tests/Shop.Api.Tests.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" /></ItemGroup></Project>',
    });
    const found = await detectProfiles(fs, { platform: 'win32' });
    expect(found).toEqual([
      {
        id: 'dotnet:src/Shop.Api/Shop.Api.csproj',
        name: 'Shop.Api',
        command: 'dotnet run',
        cwd: 'src/Shop.Api',
        kind: 'dotnet',
        framework: 'ASP.NET Core',
        url: 'https://localhost:7043',
      },
      {
        id: 'dotnet:src/Shop.Tool/Shop.Tool.csproj',
        name: 'Shop.Tool',
        command: 'dotnet run',
        cwd: 'src/Shop.Tool',
        kind: 'dotnet',
        framework: '.NET console app',
      },
    ]);
  });

  it('finds Python web apps and uses the project virtual environment', async () => {
    const django = await detectProfiles(
      memoryFs({ 'manage.py': '', '.venv/pyvenv.cfg': 'home = /usr/bin', 'requirements.txt': 'django' }),
      { platform: 'win32' },
    );
    expect(django).toEqual([
      expect.objectContaining({
        command: '.\\.venv\\Scripts\\python.exe manage.py runserver',
        framework: 'Django',
        url: 'http://localhost:8000',
      }),
    ]);
    const fastapi = await detectProfiles(
      memoryFs({
        'pyproject.toml': '[project]',
        'uv.lock': '',
        'app/main.py': 'from fastapi import FastAPI\n\napi: FastAPI = FastAPI()\n',
      }),
      { platform: 'linux' },
    );
    expect(fastapi[0]).toMatchObject({
      command: 'uv run python -m uvicorn app.main:api --reload',
      framework: 'FastAPI',
    });
    const flask = await detectProfiles(
      memoryFs({ 'requirements.txt': 'flask', 'app.py': 'from flask import Flask\napp = Flask(__name__)\n' }),
      { platform: 'linux' },
    );
    expect(flask[0]).toMatchObject({ command: 'python3 -m flask --app app run --debug', url: 'http://localhost:5000' });
  });

  it('finds Go, Rust, Spring Boot, Laravel, Rails, Deno, Docker Compose and Makefile targets', async () => {
    const fs = memoryFs({
      Makefile: 'build:\n\tgo build\ndev: build\n\tgo run .\n',
      'compose.yaml': 'services: {}',
      'api/go.mod': 'module x',
      'api/cmd/server/main.go': 'package main',
      'cli/Cargo.toml': '[package]\nname = "cli"\n',
      'cli/src/main.rs': 'fn main() {}',
      'java/pom.xml': '<artifactId>spring-boot-starter-parent</artifactId>',
      'java/mvnw': '',
      'php/artisan': '',
      'rails/Gemfile': '',
      'rails/config.ru': '',
      'rails/bin/rails': '',
      'deno/deno.jsonc': '{ "tasks": { "dev": "deno run -A main.ts" } }',
    });
    const found = await detectProfiles(fs, { platform: 'linux' });
    expect(found.map((p) => [p.id, p.command])).toEqual([
      ['docker:', 'docker compose up'],
      ['make::dev', 'make dev'],
      ['go:api:server', 'go run ./cmd/server'],
      ['rust:cli', 'cargo run'],
      ['deno:deno', 'deno task dev'],
      ['java:java:maven', './mvnw spring-boot:run'],
      ['php:php:laravel', 'php artisan serve'],
      ['ruby:rails:rails', 'bin/rails server'],
    ]);
  });

  it('names root apps after the project', async () => {
    const found = await detectProfiles(memoryFs({ 'manage.py': '', 'go.mod': 'module x', 'main.go': '' }), {
      platform: 'linux',
      rootName: 'shop',
    });
    expect(found.map((p) => p.name)).toEqual(['shop', 'shop']);
  });

  it('respects the depth limit', async () => {
    const fs = memoryFs({ 'a/b/c/d/package.json': pkg({ scripts: { dev: 'vite' } }) });
    expect(await detectProfiles(fs, { platform: 'linux', maxDepth: 3 })).toEqual([]);
    expect(await detectProfiles(fs, { platform: 'linux', maxDepth: 4 })).toHaveLength(1);
  });
});

describe('detection helpers', () => {
  it('parses JSON with comments and trailing commas', () => {
    expect(parseJsonLoose('{ "a": "http://x", /* c */ "b": [1,], }')).toEqual({ a: 'http://x', b: [1] });
    expect(parseJsonLoose('nope')).toBeNull();
  });

  it('prefers dev scripts and knows frameworks', () => {
    expect(pickScript({ start: 'a', dev: 'b' })).toBe('dev');
    expect(pickScript({ build: 'x' })).toBeUndefined();
    expect(nodeFramework({ devDependencies: { '@sveltejs/kit': '2', vite: '6' } })).toEqual({
      name: 'SvelteKit',
      port: 5173,
    });
    expect(nodeFramework({ dependencies: { express: '5' } })).toEqual({ name: 'Node.js server' });
  });

  it('reads launch profiles and project kinds', () => {
    expect(
      parseLaunchSettings('{"profiles":{"http":{"commandName":"Project","applicationUrl":"http://0.0.0.0:5000"}}}'),
    ).toEqual([{ name: 'http', url: 'http://localhost:5000' }]);
    expect(dotnetProjectKind('<Project Sdk="Microsoft.NET.Sdk.Worker">', 'W.csproj')).toBe('Worker Service');
    expect(dotnetProjectKind('<Project Sdk="Microsoft.NET.Sdk.Web">', 'Api.Tests.csproj')).toBeNull();
  });
});
