import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isInside, resolveLink } from './index';
import { inlineImages, MAX_IMAGE_BYTES, renderFile, renderMarkdownToHtml, slugify, splitFrontMatter } from './render';

describe('renderMarkdownToHtml', () => {
  it('renders GFM tables, task lists, autolinks and heading anchors', () => {
    const html = renderMarkdownToHtml(
      [
        '# Plan: Step 1',
        '',
        '| a | b |',
        '|---|---|',
        '| 1 | 2 |',
        '',
        '- [ ] todo',
        '- [x] done',
        '',
        'See https://example.com',
        '',
        '## Plan: Step 1',
      ].join('\n'),
    );
    expect(html).toContain('<h1 id="user-content-plan-step-1">');
    expect(html).toContain('<h2 id="user-content-plan-step-1-1">');
    expect(html).toContain('<table>');
    expect(html).toContain('<ul class="contains-task-list">');
    expect(html).toContain(
      '<li class="task-list-item"><input class="task-list-item-checkbox" type="checkbox" disabled> todo',
    );
    expect(html).toContain('type="checkbox" disabled checked> done');
    expect(html).toContain('<a href="https://example.com">https://example.com</a>');
  });

  it('highlights known languages with CSS-variable colours and leaves unknown ones plain', () => {
    const html = renderMarkdownToHtml('```ts\nconst x: number = 1;\n```\n\n```nope\n<b>\n```');
    expect(html).toContain('class="shiki oxytocin"');
    expect(html).toContain('var(--shiki-token-keyword');
    expect(html).toContain('<pre><code class="language-nope">&lt;b&gt;');
  });

  it('shows front matter as a YAML block', () => {
    expect(splitFrontMatter('---\ntitle: x\n---\n# Body')).toEqual({ frontMatter: 'title: x', body: '# Body' });
    expect(splitFrontMatter('# No front matter')).toEqual({ body: '# No front matter' });
    const html = renderMarkdownToHtml('---\ntitle: x\n---\n# Body');
    expect(html).toMatch(/^<div class="front-matter"><pre class="shiki/);
    expect(html).not.toContain('<hr>');
  });

  it('slugifies like GitHub', () => {
    expect(slugify('Hello, World! 2.0')).toBe('hello-world-20');
    expect(slugify('  Zażółć gęślą  ')).toBe('zażółć-gęślą');
  });
});

describe('inlineImages', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'oxy-md-'));
    await mkdir(join(root, 'docs/img'), { recursive: true });
    await writeFile(join(root, 'docs/img/a.png'), Buffer.from([1, 2, 3]));
    await writeFile(join(root, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('inlines relative and root-relative images and replaces the rest with placeholders', async () => {
    const html = await inlineImages(
      [
        '<img src="img/a.png" alt="a">',
        '<img src="/logo.svg" alt="logo">',
        '<img src="https://example.com/x.png" alt="remote">',
        '<img src="img/missing.png" alt="m">',
        '<img src="../../outside.png" alt="o">',
        '<img src="img/a.txt" alt="t">',
      ].join('\n'),
      { filePath: join(root, 'docs/README.md'), rootPath: root },
    );
    const lines = html.split('\n');
    expect(lines[0]).toBe('<img src="data:image/png;base64,AQID" alt="a">');
    expect(lines[1]).toMatch(/^<img src="data:image\/svg\+xml;base64,/);
    expect(lines[2]).toContain('class="image-placeholder"');
    expect(lines[2]).toContain('🖼 remote');
    expect(lines[3]).toContain('missing.png (not found)');
    expect(lines[4]).toContain('🖼 outside.png');
    expect(lines[5]).toContain('🖼 a.txt');
  });

  it('enforces the per-image and per-document limits', async () => {
    const sizes: Record<string, number> = { 'a.png': MAX_IMAGE_BYTES + 1, 'b.png': 4 * 1024 * 1024 };
    const html = await inlineImages(
      ['<img src="a.png">', ...Array.from({ length: 6 }, (_, i) => `<img src="b.png?${i}">`)].join('\n'),
      {
        filePath: join(root, 'x.md'),
        rootPath: root,
        statSize: (p) => Promise.resolve(sizes[p.split(/[\\/]/).at(-1)!] ?? 0),
        readFile: (p) => Promise.resolve(Buffer.alloc(sizes[p.split(/[\\/]/).at(-1)!] ?? 0)),
      },
    );
    const lines = html.split('\n');
    expect(lines[0]).toContain('a.png (too large)');
    // 5 × 4 MB fit into 20 MB, the sixth does not.
    expect(lines.slice(1, 6).every((l) => l.startsWith('<img src="data:image/png'))).toBe(true);
    expect(lines[6]).toContain('b.png (too large)');
  });

  it('renders a file end to end', async () => {
    await writeFile(join(root, 'docs/README.md'), '# Title\n\n![a](img/a.png)\n');
    const html = await renderFile(join(root, 'docs/README.md'), root);
    expect(html).toContain('<h1 id="user-content-title">Title</h1>');
    expect(html).toContain('src="data:image/png;base64,AQID"');
  });
});

describe('links', () => {
  const root = join(tmpdir(), 'proj');
  const file = join(root, 'docs/plan.md');
  it('resolves external, relative, root-relative and escaping links', () => {
    expect(resolveLink('https://x.dev/a', file, root)).toEqual({ kind: 'external', url: 'https://x.dev/a' });
    expect(resolveLink('other.md#part', file, root)).toEqual({ kind: 'file', path: join(root, 'docs/other.md') });
    expect(resolveLink('/README.md', file, root)).toEqual({ kind: 'file', path: join(root, 'README.md') });
    expect(resolveLink('my%20notes.md', file, root)).toEqual({ kind: 'file', path: join(root, 'docs/my notes.md') });
    expect(resolveLink('../../etc/passwd', file, root)).toEqual({ kind: 'invalid' });
    expect(resolveLink('javascript:alert(1)', file, root)).toEqual({ kind: 'invalid' });
    expect(resolveLink('mailto:a@b.c', file, root)).toEqual({ kind: 'invalid' });
  });

  it('checks containment, case-insensitively where the file system is', () => {
    expect(isInside('/a/b', '/a/b/c.md', false)).toBe(true);
    expect(isInside('/a/b', '/a/bc/c.md', false)).toBe(false);
    expect(isInside('/a/B', '/a/b/c.md', true)).toBe(true);
    // Windows' path.relative already compares case-insensitively.
    if (process.platform !== 'win32') expect(isInside('/a/B', '/a/b/c.md', false)).toBe(false);
  });
});
