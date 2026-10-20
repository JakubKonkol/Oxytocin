/**
 * Anonymizes agent logs into Usage Monitor test fixtures: keeps only usage
 * metadata (ids, timestamps, models, token counts, cwd) and drops every message, prompt, tool input/output and
 * thought. Paths are replaced by `/fixture/proj` (or the value of `--cwd`).
 *
 * Usage: `tsx scripts/make-fixtures.ts --source claude|codex|gemini --in <file.jsonl> --out <file.jsonl>
 *         [--cwd /fixture/proj] [--limit <usage records>]`
 *        `tsx scripts/make-fixtures.ts --source code-map|code-map-csharp --out <directory> [--count 10000]`
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

type Json = Record<string, unknown>;
type Source = 'claude' | 'codex' | 'gemini';

/** Deterministic module graph with cross-package imports, classes, types and Unicode. */
export function codeMapFixtureSource(index: number): string {
  const dependency = Math.max(0, index - 1);
  return [
    index
      ? `import { Service${dependency} } from '../package-${Math.floor(dependency / 100)}/module-${dependency}';`
      : '',
    `export interface Input${index} { name: string; count: number }`,
    `export type Result${index} = { value: string; count: number };`,
    `export class Service${index} {`,
    `  readonly label = 'zażółć 🗺️';`,
    `  run(input: Input${index}): Result${index} {`,
    index ? `    const previous = new Service${dependency}().run(input);` : '    const previous = input;',
    `    return { value: this.label + input.name, count: previous.count + 1 };`,
    '  }',
    '}',
    `export function create${index}(): Service${index} { return new Service${index}(); }`,
    '',
  ].join('\n');
}

export async function makeCodeMapFixture(root: string, count = 10_000): Promise<void> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 50_000) throw new Error('Invalid fixture file count');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'code-map-fixture', private: true }));
  for (let start = 0; start < count; start += 100) {
    const directory = join(root, `package-${Math.floor(start / 100)}`);
    await mkdir(directory, { recursive: true });
    await Promise.all(
      Array.from({ length: Math.min(100, count - start) }, (_, offset) => {
        const index = start + offset;
        return writeFile(join(directory, `module-${index}.ts`), codeMapFixtureSource(index));
      }),
    );
  }
}
export async function makeCodeMapGoFixture(root: string, count = 10_000): Promise<void> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 50_000) throw new Error('Invalid fixture file count');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'go.mod'), 'module example.test/fixture\ngo 1.24\n');
  for (let start = 0; start < count; start += 100) {
    const pkg = Math.floor(start / 100),
      directory = join(root, `pkg${pkg}`);
    await mkdir(directory, { recursive: true });
    await Promise.all(
      Array.from({ length: Math.min(100, count - start) }, (_, offset) => {
        const index = start + offset;
        return writeFile(
          join(directory, `service${index}.go`),
          `package pkg${pkg}\n${offset === 0 && pkg ? `import prev "example.test/fixture/pkg${pkg - 1}"\n` : ''}type Service${index} struct { Value int }\nfunc (s *Service${index}) Run() { Work${index}() }\nfunc Work${index}() { ${index ? `${offset ? '' : 'prev.'}Work${index - 1}()` : ''} }\n`,
        );
      }),
    );
  }
}

const CSHARP_FILES_PER_PROJECT = 500;
/** Deterministic C# solution: file-scoped namespaces, records, interfaces, partial types and cross-project calls. */
export function codeMapCSharpFixtureSource(index: number): string {
  const project = Math.floor(index / CSHARP_FILES_PER_PROJECT);
  const dependency = Math.max(0, index - 1);
  const dependencyProject = Math.floor(dependency / CSHARP_FILES_PER_PROJECT);
  return [
    dependencyProject !== project ? `using Fixture.Project${dependencyProject}.Services;` : '',
    `namespace Fixture.Project${project}.Services;`,
    '',
    `public interface IService${index} { Result${index} Run(Input${index} input); }`,
    `public record Input${index}(string Name = "zażółć 🗺️", int Count = 0);`,
    `public record Result${index}(int Count);`,
    '',
    `public partial class Service${index} : IService${index}`,
    '{',
    index ? `    private readonly Service${dependency} previous = new Service${dependency}();` : '',
    `    public Result${index} Run(Input${index} input)`,
    '    {',
    index
      ? `        var value = previous.Run(new Input${dependency}(input.Name, input.Count));`
      : '        var value = new Result0(input.Count);',
    `        return new Result${index}(value.Count + 1);`,
    '    }',
    '}',
    '',
    `public partial class Service${index}`,
    '{',
    `    public static Service${index} Create() => new Service${index}();`,
    '}',
    '',
  ]
    .filter((line, position) => line || position > 1)
    .join('\n');
}

export async function makeCodeMapCSharpFixture(root: string, count = 10_000): Promise<void> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 50_000) throw new Error('Invalid fixture file count');
  await mkdir(root, { recursive: true });
  const projects = Math.ceil(count / CSHARP_FILES_PER_PROJECT);
  await writeFile(
    join(root, 'Directory.Build.props'),
    '<Project>\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n    <ImplicitUsings>enable</ImplicitUsings>\n  </PropertyGroup>\n</Project>\n',
  );
  await writeFile(
    join(root, 'Fixture.sln'),
    Array.from(
      { length: projects },
      (_, project) =>
        `Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Project${project}", "Project${project}\\Project${project}.csproj", "{${String(project).padStart(8, '0')}-0000-0000-0000-000000000000}"\nEndProject\n`,
    ).join(''),
  );
  for (let project = 0; project < projects; project++) {
    const directory = join(root, `Project${project}`);
    await mkdir(join(directory, 'Services'), { recursive: true });
    await writeFile(
      join(directory, `Project${project}.csproj`),
      `<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n${project ? `    <ProjectReference Include="..\\Project${project - 1}\\Project${project - 1}.csproj" />\n` : ''}  </ItemGroup>\n</Project>\n`,
    );
    const start = project * CSHARP_FILES_PER_PROJECT;
    await Promise.all(
      Array.from({ length: Math.min(CSHARP_FILES_PER_PROJECT, count - start) }, (_, offset) =>
        writeFile(
          join(directory, 'Services', `Service${start + offset}.cs`),
          codeMapCSharpFixtureSource(start + offset),
        ),
      ),
    );
  }
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function pick(o: Json, keys: string[]): Json {
  const out: Json = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/** Claude Code transcript line → usage metadata only (`null` = drop the line). */
export function anonymizeClaude(o: Json, cwd: string): Json | null {
  if (o['type'] !== 'assistant' && o['type'] !== 'user') return null;
  const out = pick(o, ['type', 'timestamp', 'sessionId', 'uuid', 'parentUuid', 'isSidechain', 'version', 'requestId']);
  if (typeof o['cwd'] === 'string') out['cwd'] = cwd;
  const message = isObject(o['message']) ? o['message'] : null;
  if (message) {
    const m = pick(message, ['id', 'type', 'role', 'model', 'usage', 'stop_reason']);
    // Content blocks are replaced by their types only.
    if (Array.isArray(message['content']))
      m['content'] = message['content'].map((b) => (isObject(b) ? { type: b['type'] } : { type: 'text' }));
    out['message'] = m;
  }
  if (typeof o['costUSD'] === 'number') out['costUSD'] = o['costUSD'];
  return out;
}

/** Codex rollout line → session/model/token metadata only. */
export function anonymizeCodex(o: Json, cwd: string): Json | null {
  const payload = isObject(o['payload']) ? o['payload'] : {};
  if (o['type'] === 'session_meta') {
    const p = pick(payload, ['id', 'timestamp', 'originator', 'cli_version']);
    if (typeof payload['cwd'] === 'string') p['cwd'] = cwd;
    return { timestamp: o['timestamp'], type: 'session_meta', payload: p };
  }
  if (o['type'] === 'turn_context') {
    const p = pick(payload, ['model', 'effort', 'service_tier']);
    if (typeof payload['cwd'] === 'string') p['cwd'] = cwd;
    return { timestamp: o['timestamp'], type: 'turn_context', payload: p };
  }
  if (o['type'] === 'event_msg' && payload['type'] === 'token_count')
    return { timestamp: o['timestamp'], type: 'event_msg', payload: pick(payload, ['type', 'info', 'rate_limits']) };
  return null;
}

/** Gemini CLI chat record → metadata and message token records only. */
export function anonymizeGemini(o: Json): Json | null {
  if (typeof o['sessionId'] === 'string' && typeof o['projectHash'] === 'string')
    return pick(o, ['sessionId', 'projectHash', 'startTime', 'lastUpdated', 'kind']);
  if (isObject(o['$set'])) {
    const set = pick(o['$set'], ['lastUpdated']);
    return Object.keys(set).length > 0 ? { $set: set } : null;
  }
  if (typeof o['id'] === 'string' && typeof o['type'] === 'string') {
    const m = pick(o, ['id', 'timestamp', 'type', 'model', 'tokens']);
    m['content'] = '';
    return m;
  }
  return null;
}

function hasUsage(source: Source, o: Json): boolean {
  if (source === 'claude') return isObject(o['message']) && isObject(o['message']['usage']);
  if (source === 'codex') return isObject(o['payload']) && o['payload']['type'] === 'token_count';
  return isObject(o['tokens']);
}

export function anonymize(source: Source, text: string, opts: { cwd: string; limit?: number }): string {
  const out: string[] = [];
  let usage = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(o)) continue;
    const a =
      source === 'claude'
        ? anonymizeClaude(o, opts.cwd)
        : source === 'codex'
          ? anonymizeCodex(o, opts.cwd)
          : anonymizeGemini(o);
    if (!a) continue;
    if (hasUsage(source, a)) {
      if (opts.limit !== undefined && usage >= opts.limit) break;
      usage++;
    }
    out.push(JSON.stringify(a));
  }
  return out.length > 0 ? `${out.join('\n')}\n` : '';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const source = arg('source');
  const input = arg('in');
  const output = arg('out');
  if ((source === 'code-map' || source === 'code-map-csharp') && output) {
    await (source === 'code-map' ? makeCodeMapFixture : makeCodeMapCSharpFixture)(
      output,
      Number(arg('count') ?? 10_000),
    );
    return;
  }
  if (!source || !['claude', 'codex', 'gemini'].includes(source) || !input || !output) {
    console.error('Usage: tsx scripts/make-fixtures.ts --source claude|codex|gemini --in <file> --out <file>');
    process.exit(2);
  }
  const limit = arg('limit');
  const result = anonymize(source as Source, await readFile(input, 'utf8'), {
    cwd: arg('cwd') ?? '/fixture/proj',
    ...(limit ? { limit: Number(limit) } : {}),
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, result);
  console.log(`${output}: ${result.split('\n').length - 1} lines`);
}

if (process.argv[1]?.endsWith('make-fixtures.ts')) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
