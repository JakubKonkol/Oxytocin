import { posix } from 'node:path';
import { z } from 'zod';

const value = z.string().max(4096);
const UsingItemSchema = z.object({ name: value, static: z.boolean(), alias: value.nullable() });
export const DotnetProjectSchema = z.object({
  sdk: value.nullable(),
  rootNamespace: value.nullable(),
  assemblyName: value.nullable(),
  targetFrameworks: z.array(value).max(50),
  implicitUsings: z.boolean().nullable(),
  outputType: value.nullable(),
  isTestProject: z.boolean().nullable(),
  /** Project-relative POSIX paths; entries starting with `..` point outside the checkout. */
  projectReferences: z.array(value).max(2000),
  packageReferences: z.array(value).max(2000),
  compileRemove: z.array(value).max(2000),
  usings: z.array(UsingItemSchema).max(2000),
  usingRemoves: z.array(value).max(2000),
});
export type DotnetProject = z.infer<typeof DotnetProjectSchema>;
export const DotnetSolutionSchema = z.object({ projects: z.array(value).max(10_000) });
export type DotnetSolution = z.infer<typeof DotnetSolutionSchema>;

/**
 * Implicit global usings per SDK, as documented for .NET 6 and later. Kept in code and never read from an SDK;
 * changing the list changes graphs, so it is versioned with the record format (`EXTRACTOR_VERSION`).
 */
const BASE_USINGS = [
  'System',
  'System.Collections.Generic',
  'System.IO',
  'System.Linq',
  'System.Net.Http',
  'System.Threading',
  'System.Threading.Tasks',
];
const HOSTING_USINGS = [
  'Microsoft.Extensions.Configuration',
  'Microsoft.Extensions.DependencyInjection',
  'Microsoft.Extensions.Hosting',
  'Microsoft.Extensions.Logging',
];
export function implicitUsings(sdk: string | null): string[] {
  switch (sdk?.toLowerCase()) {
    case 'microsoft.net.sdk.web':
      return [
        ...BASE_USINGS,
        'System.Net.Http.Json',
        'Microsoft.AspNetCore.Builder',
        'Microsoft.AspNetCore.Hosting',
        'Microsoft.AspNetCore.Http',
        'Microsoft.AspNetCore.Routing',
        ...HOSTING_USINGS,
      ];
    case 'microsoft.net.sdk.worker':
      return [...BASE_USINGS, ...HOSTING_USINGS];
    case 'microsoft.net.sdk.blazorwebassembly':
      return [
        ...BASE_USINGS,
        'System.Net.Http.Json',
        'Microsoft.AspNetCore.Components.WebAssembly.Hosting',
        'Microsoft.Extensions.Configuration',
        'Microsoft.Extensions.DependencyInjection',
        'Microsoft.Extensions.Logging',
      ];
    default:
      return BASE_USINGS;
  }
}

const decode = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
function attributes(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of text.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    result.set(match[1]!.toLowerCase(), decode(match[2] ?? match[3] ?? ''));
  return result;
}
interface Element {
  name: string;
  attributes: Map<string, string>;
  text: string | null;
}
/** A tolerant reader for the flat MSBuild subset Code Map needs; conditions and imports are not evaluated. */
function elements(source: string): Element[] {
  const text = source.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const result: Element[] = [];
  for (const match of text.matchAll(/<([A-Za-z_][\w.-]*)(\s[^<>]*?)?(\/?)>/g)) {
    const name = match[1]!;
    let content: string | null = null;
    if (!match[3]) {
      const end = text.indexOf(`</${name}>`, match.index + match[0].length);
      const inner = end < 0 ? '' : text.slice(match.index + match[0].length, end);
      if (end >= 0 && !inner.includes('<')) content = decode(inner);
    }
    result.push({ name: name.toLowerCase(), attributes: attributes(match[2] ?? ''), text: content });
    if (result.length > 20_000) throw new Error('Invalid Code Map project configuration');
  }
  return result;
}
const property = (list: Element[], name: string): string | null => {
  const values = list.filter((element) => element.name === name && element.text).map((element) => element.text!);
  const last = values.at(-1);
  return last && !last.includes('$(') ? last.slice(0, 4096) : null;
};
const flag = (text: string | null): boolean | null =>
  text === null ? null : ['enable', 'true'].includes(text.toLowerCase()) ? true : false;
const items = (list: Element[], name: string, attribute: string): string[] =>
  list
    .filter((element) => element.name === name)
    .flatMap((element) => (element.attributes.get(attribute) ?? '').split(';'))
    .map((entry) => entry.trim())
    .filter((entry) => entry && !entry.includes('$('));
/** Normalizes an MSBuild path relative to the configuration file; absolute paths are dropped. */
function relativePath(from: string, entry: string): string | null {
  const normalized = entry.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) return null;
  return posix.normalize(posix.join(posix.dirname(from), normalized));
}

export function parseDotnetProject(path: string, source: string): DotnetProject {
  const list = elements(source);
  const root = list.find((element) => element.name === 'project');
  const sdk =
    root?.attributes.get('sdk') ??
    list.find((element) => element.name === 'sdk')?.attributes.get('name') ??
    list.find((element) => element.name === 'import' && element.attributes.has('sdk'))?.attributes.get('sdk') ??
    null;
  const frameworks = property(list, 'targetframeworks') ?? property(list, 'targetframework');
  return DotnetProjectSchema.parse({
    sdk: sdk ? sdk.split('/')[0]!.trim() || null : null,
    rootNamespace: property(list, 'rootnamespace'),
    assemblyName: property(list, 'assemblyname'),
    targetFrameworks: frameworks
      ? [...new Set(frameworks.split(';').map((entry) => entry.trim()))].filter(Boolean)
      : [],
    implicitUsings: flag(property(list, 'implicitusings')),
    outputType: property(list, 'outputtype'),
    isTestProject: flag(property(list, 'istestproject')),
    projectReferences: items(list, 'projectreference', 'include')
      .map((entry) => relativePath(path, entry))
      .filter((entry): entry is string => !!entry),
    packageReferences: [...new Set(items(list, 'packagereference', 'include'))],
    compileRemove: items(list, 'compile', 'remove').map((entry) => entry.replace(/\\/g, '/')),
    usings: list
      .filter((element) => element.name === 'using' && element.attributes.get('include'))
      .map((element) => ({
        name: element.attributes.get('include')!,
        static: element.attributes.get('static')?.toLowerCase() === 'true',
        alias: element.attributes.get('alias') || null,
      })),
    usingRemoves: items(list, 'using', 'remove'),
  });
}

export function parseDotnetSolution(path: string, source: string): DotnetSolution {
  const entries = path.toLowerCase().endsWith('.slnx')
    ? elements(source)
        .filter((element) => element.name === 'project')
        .map((element) => element.attributes.get('path') ?? '')
    : [...source.matchAll(/^\s*Project\("[^"]*"\)\s*=\s*"[^"]*"\s*,\s*"([^"]*)"/gm)].map((match) => match[1]!);
  return DotnetSolutionSchema.parse({
    projects: [
      ...new Set(
        entries
          .filter((entry) => /\.(cs|fs|vb)proj$/i.test(entry))
          .map((entry) => relativePath(path, entry))
          .filter((entry): entry is string => !!entry),
      ),
    ],
  });
}
