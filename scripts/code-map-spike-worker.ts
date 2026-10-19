import { readFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { join } from 'node:path';
import ts from 'typescript';
import { LANGUAGE_VERSION, MIN_COMPATIBLE_VERSION, Language, Parser } from 'web-tree-sitter';
import { z } from 'zod';
import { GrammarManifestSchema } from './code-map-grammar-manifest';

const ConfigSchema = z.object({
  assets: z.string(),
  backend: z.enum(['tree-sitter', 'typescript']),
  files: z.array(z.string()),
  csharpFiles: z.number().int().nonnegative(),
});

async function run(): Promise<void> {
  // Enforce offline parser execution even on a connected developer machine.
  Socket.prototype.connect = () => {
    throw new Error('Network access is disabled in the parser spike');
  };
  globalThis.fetch = () => Promise.reject(new Error('Network access is disabled in the parser spike'));
  const started = performance.now();
  const config = ConfigSchema.parse(JSON.parse(await readFile(process.argv[2]!, 'utf8')));
  const manifest = GrammarManifestSchema.parse(
    JSON.parse(await readFile(join(config.assets, 'grammars.json'), 'utf8')),
  );
  const languages = new Map<string, Language>();
  const smoke: { language: string; loadMs: number; abi: number; bytes: number }[] = [];
  const samples: Record<string, string> = {
    javascript: 'export function hello() { return 1; }',
    typescript: 'export function hello(): number { return 1; }',
    tsx: 'export function Hello() { return <div>Hello</div>; }',
    csharp: 'namespace Demo; public class Hello { public int Run() => 1; }',
    go: 'package demo\nfunc Hello() int { return 1 }',
    java: 'package demo; public class Hello { public int run() { return 1; } }',
    python: 'def hello():\n    return 1\n',
  };
  const initStart = performance.now();
  await Parser.init({ locateFile: () => join(config.assets, manifest.runtime.file) });
  const runtimeInitMs = performance.now() - initStart;
  for (const entry of manifest.grammars) {
    process.stderr.write(`Loading grammar: ${entry.language}\n`);
    const start = performance.now();
    const bytes = await readFile(join(config.assets, 'grammars', entry.file));
    const language = await Language.load(bytes);
    const loadMs = performance.now() - start;
    const parser = new Parser();
    try {
      parser.setLanguage(language);
      const tree = parser.parse(samples[entry.language]!);
      if (!tree || tree.rootNode.hasError) throw new Error(`Grammar smoke failed: ${entry.language}`);
      tree.delete();
    } finally {
      parser.delete();
    }
    languages.set(entry.language, language);
    smoke.push({ language: entry.language, loadMs, abi: language.abiVersion, bytes: bytes.length });
  }
  const readyMs = performance.now() - started;
  const parser = new Parser();
  let declarations = 0;
  let syntaxErrors = 0;
  const syntaxErrorFiles: string[] = [];
  let readMs = 0;
  let parseMs = 0;
  let bytes = 0;
  const parseStart = performance.now();
  process.stderr.write(`Parsing ${config.files.length + config.csharpFiles} files (${config.backend})\n`);
  function parse(source: string, filename: string, language: string): void {
    bytes += Buffer.byteLength(source);
    if (config.backend === 'typescript' && language !== 'csharp') {
      const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, false);
      const visit = (node: ts.Node) => {
        if (
          ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isVariableDeclaration(node) ||
          ts.isPropertyDeclaration(node) ||
          ts.isEnumDeclaration(node)
        )
          declarations++;
        ts.forEachChild(node, visit);
      };
      visit(file);
    } else {
      parser.setLanguage(languages.get(language)!);
      const tree = parser.parse(source);
      if (!tree) throw new Error(`Parsing failed: ${filename}`);
      try {
        if (tree.rootNode.hasError) {
          syntaxErrors++;
          if (syntaxErrorFiles.length < 20) syntaxErrorFiles.push(filename);
        }
        const cursor = tree.walk();
        try {
          let done = false;
          while (!done) {
            if (
              /^(function_declaration|class_declaration|interface_declaration|type_alias_declaration|method_definition|method_declaration|variable_declarator|public_field_definition|enum_declaration|property_declaration)$/.test(
                cursor.nodeType,
              )
            )
              declarations++;
            if (cursor.gotoFirstChild()) continue;
            while (!cursor.gotoNextSibling()) {
              if (!cursor.gotoParent()) {
                done = true;
                break;
              }
            }
          }
        } finally {
          cursor.delete();
        }
      } finally {
        tree.delete();
      }
    }
  }
  try {
    for (let offset = 0; offset < config.files.length; offset += 32) {
      const filenames = config.files.slice(offset, offset + 32);
      const readStart = performance.now();
      const sources = await Promise.all(filenames.map((filename) => readFile(filename, 'utf8')));
      readMs += performance.now() - readStart;
      const batchStart = performance.now();
      for (let index = 0; index < filenames.length; index++) {
        const filename = filenames[index]!;
        const language = /\.tsx$/.test(filename) ? 'tsx' : /\.[cm]?jsx?$/.test(filename) ? 'javascript' : 'typescript';
        parse(sources[index]!, filename, language);
      }
      parseMs += performance.now() - batchStart;
    }
    const csharpStart = performance.now();
    for (let index = 0; index < config.csharpFiles; index++) {
      parse(
        `namespace Sample; public interface IRun${index} { int Run(int value); } public partial class Service${index} : IRun${index} { public int Run(int value) => value + 1; public string Name { get; set; } = "zażółć 🗺️"; }`,
        `Service${index}.cs`,
        'csharp',
      );
    }
    parseMs += performance.now() - csharpStart;
  } finally {
    parser.delete();
  }
  const durationMs = performance.now() - parseStart;
  process.parentPort.postMessage({
    offline: true,
    backend: config.backend,
    files: config.files.length + config.csharpFiles,
    bytes,
    declarations,
    syntaxErrors,
    durationMs,
    readMs,
    parseMs,
    syntaxErrorFiles,
    filesPerSecond: ((config.files.length + config.csharpFiles) / durationMs) * 1000,
    runtimeInitMs,
    readyMs,
    maxRssMiB: process.resourceUsage().maxRSS / 1024,
    rssMiB: process.memoryUsage().rss / 1024 / 1024,
    smoke,
    abi: { minimum: MIN_COMPATIBLE_VERSION, maximum: LANGUAGE_VERSION },
    versions: process.versions,
  });
}

void run().catch((error: unknown) => {
  process.parentPort.postMessage({ error: error instanceof Error ? error.stack : String(error) });
  process.exitCode = 1;
});
