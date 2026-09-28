import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { looksBinary, PREVIEW_EXTENSIONS, previewKind, readPreviewText, renderCodeToHtml } from './code';

describe('previewKind', () => {
  it('knows Markdown, code, plain text and special file names', () => {
    expect(previewKind('/p/CLAUDE.md')).toEqual({ kind: 'markdown' });
    expect(previewKind('/p/src/App.TSX')).toEqual({ kind: 'code', language: 'tsx' });
    expect(previewKind('/p/Api/Api.csproj')).toEqual({ kind: 'code', language: 'xml' });
    expect(previewKind('/p/notes.txt')).toEqual({ kind: 'code', language: null });
    expect(previewKind('/p/Dockerfile')).toEqual({ kind: 'code', language: 'dockerfile' });
    expect(previewKind('/p/.env.local')).toEqual({ kind: 'code', language: 'ini' });
    expect(previewKind('/p/logo.png')).toBeNull();
    expect(PREVIEW_EXTENSIONS).toContain('.py');
    expect(PREVIEW_EXTENSIONS.every((e) => /^\.[\w.-]+$/.test(e))).toBe(true);
  });
});

describe('renderCodeToHtml', () => {
  it('highlights known languages with one span per line', () => {
    const html = renderCodeToHtml('const a = 1;\r\n\r\nexport { a };\n', 'typescript');
    expect(html).toMatch(/^<pre class="code-view shiki oxytocin" data-language="typescript"><code>/);
    expect(html.match(/<span class="line">/g)).toHaveLength(3);
    expect(html).toContain('style="color:var(--shiki-token-keyword)');
  });

  it('escapes plain text and keeps empty lines', () => {
    const html = renderCodeToHtml('<b>&\n\nx', null);
    expect(html).toBe(
      '<pre class="code-view"><code><span class="line">&lt;b&gt;&amp;</span>\n<span class="line"> </span>\n<span class="line">x</span></code></pre>',
    );
  });
});

describe('readPreviewText', () => {
  it('reads text and rejects binary files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oxy-preview-'));
    await writeFile(join(dir, 'a.ts'), '\uFEFFlet x = 1;');
    await writeFile(join(dir, 'b.bin'), Buffer.from([1, 2, 0, 3]));
    expect(await readPreviewText(join(dir, 'a.ts'))).toBe('let x = 1;');
    await expect(readPreviewText(join(dir, 'b.bin'))).rejects.toThrow(/Binary file/);
    expect(looksBinary(Buffer.from('plain'))).toBe(false);
  });
});
