import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  'target',
  'vendor',
  'coverage',
  '__pycache__',
  'bower_components',
]);
const MARKDOWN = /\.(md|markdown|mdx)$/i;

export interface MarkdownFile {
  path: string;
  /** Relative to the project root, '/' separators. */
  relativePath: string;
}

/**
 * Markdown files of a project for the "Open Preview" pick: breadth-first, skipping dependency/build folders and
 * hidden folders (except `.github`), at most `limit` files. Root README files come first, then shallower paths.
 */
export async function listMarkdownFiles(root: string, limit = 2000, maxDepth = 8): Promise<MarkdownFile[]> {
  const files: MarkdownFile[] = [];
  let level = [root];
  for (let depth = 0; depth <= maxDepth && level.length > 0 && files.length < limit; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIPPED_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.github')) continue;
          next.push(full);
        } else if (e.isFile() && MARKDOWN.test(e.name)) {
          files.push({ path: full, relativePath: relative(root, full).split(sep).join('/') });
          if (files.length >= limit) break;
        }
      }
      if (files.length >= limit) break;
    }
    level = next;
  }
  const isReadme = (f: MarkdownFile) => /^readme\.(md|markdown|mdx)$/i.test(f.relativePath);
  return files.sort((a, b) => Number(isReadme(b)) - Number(isReadme(a)));
}
