import { posix } from 'node:path';
import { parse, type ParseError } from 'jsonc-parser';
import { z } from 'zod';
import { parseDotnetProject, parseDotnetSolution, type DotnetProject, type DotnetSolution } from './dotnet-projects';

const path = z.string().max(4096);
const PackageSchema = z.object({
  name: z.string().max(300).optional(),
  main: path.optional(),
  types: path.optional(),
  typings: path.optional(),
  exports: z.json().optional(),
  bin: z.union([path, z.record(z.string(), path)]).optional(),
  workspaces: z.union([z.array(path).max(2000), z.object({ packages: z.array(path).max(2000) })]).optional(),
});
const TypeScriptSchema = z.object({
  extends: z.union([path, z.array(path).max(20)]).optional(),
  compilerOptions: z
    .object({ baseUrl: path.optional(), paths: z.record(z.string().max(500), z.array(path).max(20)).optional() })
    .optional(),
  references: z.array(z.object({ path })).max(2000).optional(),
});
export type PackageConfig = z.infer<typeof PackageSchema>;
export type TypeScriptConfig = z.infer<typeof TypeScriptSchema>;
export type ProjectConfig =
  | { kind: 'package'; data: PackageConfig }
  | { kind: 'typescript'; data: TypeScriptConfig }
  | { kind: 'dotnet-project'; data: DotnetProject }
  | { kind: 'dotnet-props'; data: DotnetProject }
  | { kind: 'dotnet-solution'; data: DotnetSolution };

/** Keep selected configuration as runtime data; scripts, credentials and raw config text never enter the cache. */
export function parseProjectConfig(path: string, source: string): ProjectConfig | null {
  const name = posix.basename(path).toLowerCase();
  if (name.endsWith('.csproj')) return { kind: 'dotnet-project', data: parseDotnetProject(path, source) };
  if (name === 'directory.build.props') return { kind: 'dotnet-props', data: parseDotnetProject(path, source) };
  if (name.endsWith('.sln') || name.endsWith('.slnx'))
    return { kind: 'dotnet-solution', data: parseDotnetSolution(path, source) };
  if (!/(^|\/)(package\.json|[jt]sconfig[^/]*\.json)$/.test(path)) return null;
  const errors: ParseError[] = [];
  const value: unknown = parse(source, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error('Invalid Code Map project configuration');
  return path.endsWith('package.json')
    ? { kind: 'package', data: PackageSchema.parse(value) }
    : { kind: 'typescript', data: TypeScriptSchema.parse(value) };
}
