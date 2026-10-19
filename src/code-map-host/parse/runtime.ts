import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Language, Parser, type Tree } from 'web-tree-sitter';
import { GrammarManifestSchema } from '@shared/domain/code-map-grammars';
import { sha256 } from '../store/writer';

export class ParserRuntime {
  private parser: Parser | undefined;
  private manifest: ReturnType<typeof GrammarManifestSchema.parse> | undefined;
  private readonly languages = new Map<string, Language>();
  constructor(private readonly assets: string) {}
  private async init(): Promise<void> {
    if (this.parser) return;
    const manifest = GrammarManifestSchema.parse(
      JSON.parse(await readFile(join(this.assets, 'grammars.json'), 'utf8')),
    );
    const wasm = await readFile(join(this.assets, manifest.runtime.file));
    if (sha256(wasm) !== manifest.runtime.sha256) throw new Error('Code Map runtime integrity mismatch');
    await Parser.init({ wasmBinary: wasm, locateFile: () => join(this.assets, manifest.runtime.file) });
    this.manifest = manifest;
    this.parser = new Parser();
  }
  async parse(source: string, language: string): Promise<Tree> {
    await this.init();
    let grammar = this.languages.get(language);
    if (!grammar) {
      const entry = this.manifest!.grammars.find((entry) => entry.language === language);
      if (!entry) throw new Error('Code Map grammar is not bundled');
      const wasm = await readFile(join(this.assets, 'grammars', entry.file));
      if (sha256(wasm) !== entry.sha256) throw new Error('Code Map grammar integrity mismatch');
      grammar = await Language.load(wasm);
      this.languages.set(language, grammar);
    }
    this.parser!.setLanguage(grammar);
    const tree = this.parser!.parse(source);
    if (!tree) throw new Error('Code Map parser returned no tree');
    return tree;
  }
  dispose(): void {
    this.parser?.delete();
    this.parser = undefined;
    this.languages.clear();
  }
}
