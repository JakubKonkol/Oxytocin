import { describe, expect, it } from 'vitest';
import { fileRecord } from '../extract/files';
import type { FileRecord } from '../extract/record';
import { parseProjectConfig, type ProjectConfig } from './config';
import { ModuleResolver } from './modules';

function resolver(configFiles: Record<string, string>, sources: string[]): ModuleResolver {
  const configs = new Map<string, ProjectConfig>();
  for (const [path, source] of Object.entries(configFiles)) configs.set(path, parseProjectConfig(path, source)!);
  const records = new Map<string, FileRecord>(sources.map((path) => [path, fileRecord(path, '')]));
  return new ModuleResolver(records, configs);
}

describe('solution-style tsconfig project references', () => {
  const solution =
    '{ "files": [], "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.web.json" }] }';
  const files = {
    'tsconfig.json': solution,
    'tsconfig.node.json':
      '{ "compilerOptions": { "paths": { "@shared/*": ["./src/shared/*"], "@split/*": ["./src/node/*"] } } }',
    'tsconfig.web.json':
      '{ "compilerOptions": { "paths": { "@shared/*": ["./src/shared/*"], "@renderer/*": ["./src/renderer/*"], "@split/*": ["./src/web/*"] } } }',
  };
  const sources = ['src/shared/a.ts', 'src/renderer/view.ts', 'src/node/same.ts', 'src/web/same.ts', 'src/main/use.ts'];

  it('takes path mappings from the referenced projects', () => {
    const modules = resolver(files, sources);
    expect(modules.resolve('src/main/use.ts', '@shared/a')).toEqual({ kind: 'file', path: 'src/shared/a.ts' });
    expect(modules.resolve('src/main/use.ts', '@renderer/view')).toEqual({
      kind: 'file',
      path: 'src/renderer/view.ts',
    });
    expect(modules.resolve('src/main/use.ts', '@shared/missing')).toEqual({
      kind: 'unresolved',
      reason: 'path-mapping-target-not-indexed',
    });
  });
  it('refuses a specifier that two projects map to different files and keeps packages external', () => {
    const modules = resolver(files, sources);
    expect(modules.resolve('src/main/use.ts', '@split/same')).toEqual({
      kind: 'unresolved',
      reason: 'ambiguous-path-mapping',
    });
    expect(modules.resolve('src/main/use.ts', 'zod')).toEqual({ kind: 'package', name: 'zod' });
  });
  it('is unchanged for a tsconfig that maps paths itself', () => {
    const modules = resolver(
      {
        'tsconfig.json':
          '{ "compilerOptions": { "paths": { "@own/*": ["./lib/*"] } }, "references": [{ "path": "./other" }] }',
        'other/tsconfig.json': '{ "compilerOptions": { "paths": { "@own/*": ["./elsewhere/*"] } } }',
      },
      ['lib/a.ts', 'other/elsewhere/a.ts'],
    );
    expect(modules.resolve('lib/a.ts', '@own/a')).toEqual({ kind: 'file', path: 'lib/a.ts' });
  });
});
