import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyCodeMapAssets } from './code-map-assets';
import { GrammarManifestSchema } from './code-map-grammar-manifest';
import { codeMapFixtureSource, makeCodeMapFixture } from './make-fixtures';

const directories: string[] = [];
async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'oxy-parser-żółć '));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Code Map parser assets', () => {
  it('ships hash-verified WASM for all seven grammars, without native bindings', async () => {
    const output = await temporary();
    await copyCodeMapAssets(output);
    const manifest = GrammarManifestSchema.parse(JSON.parse(await readFile(join(output, 'grammars.json'), 'utf8')));
    expect(manifest.grammars.map((entry) => entry.language)).toEqual([
      'javascript',
      'typescript',
      'tsx',
      'csharp',
      'go',
      'java',
      'python',
    ]);
    expect(await readdir(output)).toEqual(['grammars', 'grammars.json', 'web-tree-sitter.wasm']);
    for (const entry of manifest.grammars) {
      expect(
        createHash('sha256')
          .update(await readFile(join(output, 'grammars', entry.file)))
          .digest('hex'),
      ).toBe(entry.sha256);
      expect(await readFile(join('node_modules', entry.package, 'LICENSE'), 'utf8')).toContain('MIT');
    }
  });

  it('fails the build when an asset has changed', async () => {
    const root = await temporary();
    await mkdir(join(root, 'resources/code-map'), { recursive: true });
    await mkdir(join(root, 'node_modules/web-tree-sitter'), { recursive: true });
    const manifest = JSON.parse(await readFile('resources/code-map/grammars.json', 'utf8')) as unknown;
    await writeFile(join(root, 'resources/code-map/grammars.json'), JSON.stringify(manifest));
    await writeFile(
      join(root, 'node_modules/web-tree-sitter/package.json'),
      JSON.stringify({ version: '0.27.1', license: 'MIT' }),
    );
    await writeFile(join(root, 'node_modules/web-tree-sitter/web-tree-sitter.wasm'), 'changed');
    await expect(copyCodeMapAssets(join(root, 'output'), root)).rejects.toThrow('integrity mismatch');
  });

  it('generates deterministic imports across package boundaries and validates the file limit', async () => {
    const root = await temporary();
    await makeCodeMapFixture(root, 101);
    expect(await readFile(join(root, 'package-1/module-100.ts'), 'utf8')).toBe(codeMapFixtureSource(100));
    expect(codeMapFixtureSource(100)).toContain("from '../package-0/module-99'");
    expect(codeMapFixtureSource(0)).not.toContain('import');
    await expect(makeCodeMapFixture(root, 50_001)).rejects.toThrow('Invalid fixture');
  });
});
