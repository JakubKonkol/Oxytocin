import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listMarkdownFiles } from './files';

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function tree(files: string[]): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'oxy-md-'));
  for (const f of files) {
    await mkdir(join(root, f, '..'), { recursive: true });
    await writeFile(join(root, f), '# x\n');
  }
  return root;
}

describe('listMarkdownFiles', () => {
  it('lists Markdown files breadth-first with the root README first, skipping dependency and hidden folders', async () => {
    const dir = await tree([
      'docs/plan.md',
      'CHANGELOG.md',
      'README.md',
      'docs/deep/notes.markdown',
      'site/page.mdx',
      'src/index.ts',
      'node_modules/pkg/README.md',
      '.git/info.md',
      '.cache/x.md',
      '.github/PULL_REQUEST_TEMPLATE.md',
    ]);
    const files = await listMarkdownFiles(dir);
    expect(files.map((f) => f.relativePath)).toEqual([
      'README.md',
      'CHANGELOG.md',
      '.github/PULL_REQUEST_TEMPLATE.md',
      'docs/plan.md',
      'site/page.mdx',
      'docs/deep/notes.markdown',
    ]);
    expect(files[0]!.path).toBe(join(dir, 'README.md'));
  });

  it('stops at the limit and the depth', async () => {
    const dir = await tree(['a.md', 'b.md', 'c.md', 'x/y/z/deep.md']);
    expect(await listMarkdownFiles(dir, 2)).toHaveLength(2);
    expect((await listMarkdownFiles(dir, 100, 1)).map((f) => f.relativePath)).toEqual(['a.md', 'b.md', 'c.md']);
  });
});
