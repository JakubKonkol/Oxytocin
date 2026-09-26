import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, basename, isAbsolute, join, relative, resolve } from 'node:path';
import markdownIt, { type MarkdownIt, type StateCore } from 'markdown-it';
import { highlightCode } from './highlight';

export const HEADING_ID_PREFIX = 'user-content-';
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENT_IMAGE_BYTES = 20 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

/** GitHub-style heading slugs: lower case, punctuation removed, spaces → dashes. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * `id` attributes on headings (unique per document) so `#anchor` links work. Prefixed like on GitHub so they can never
 * clobber DOM globals (the view resolves `#slug` to `user-content-slug`).
 */
function headingAnchors(md: MarkdownIt): void {
  md.core.ruler.push('oxy_heading_anchors', (state: StateCore) => {
    const seen = new Map<string, number>();
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i]!.type !== 'heading_open') continue;
      const inline = tokens[i + 1];
      const text = (inline?.children ?? [])
        .filter((t) => t.type === 'text' || t.type === 'code_inline')
        .map((t) => t.content)
        .join('');
      const base = slugify(text) || 'section';
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      tokens[i]!.attrSet('id', `${HEADING_ID_PREFIX}${n === 0 ? base : `${base}-${n}`}`);
    }
  });
}

/** GFM task lists: `- [ ] todo` / `- [x] done` → disabled checkboxes. */
function taskLists(md: MarkdownIt): void {
  md.core.ruler.after('inline', 'oxy_task_lists', (state: StateCore) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i]!;
      if (inline.type !== 'inline' || tokens[i - 1]!.type !== 'paragraph_open') continue;
      if (tokens[i - 2]!.type !== 'list_item_open') continue;
      const first = inline.children?.[0];
      const match = first?.type === 'text' ? /^\[([ xX])\]\s/.exec(first.content) : null;
      if (!first || !match) continue;
      first.content = first.content.slice(match[0].length);
      const checkbox = new state.Token('html_inline', '', 0);
      checkbox.content = `<input class="task-list-item-checkbox" type="checkbox" disabled${match[1] === ' ' ? '' : ' checked'}> `;
      inline.children!.unshift(checkbox);
      tokens[i - 2]!.attrJoin('class', 'task-list-item');
      // Mark the enclosing list.
      for (let j = i - 3; j >= 0; j--) {
        const t = tokens[j]!;
        if ((t.type === 'bullet_list_open' || t.type === 'ordered_list_open') && t.level === tokens[i - 2]!.level - 1) {
          if (!String(t.attrGet('class') ?? '').includes('contains-task-list'))
            t.attrJoin('class', 'contains-task-list');
          break;
        }
      }
    }
  });
}

function createMarkdown(): MarkdownIt {
  const md: MarkdownIt = markdownIt({
    html: true,
    linkify: true,
    typographer: false,
    highlight: (code, lang) => highlightCode(code, lang) ?? '',
  });
  md.use(headingAnchors);
  md.use(taskLists);
  return md;
}

let markdown: MarkdownIt | undefined;

/** YAML front matter (`---` … `---` at the very top) is shown as a code block instead of a stray `<hr>`. */
export function splitFrontMatter(source: string): { frontMatter?: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n?/.exec(source);
  if (!match) return { body: source };
  return { frontMatter: match[1], body: source.slice(match[0].length) };
}

export function renderMarkdownToHtml(source: string): string {
  markdown ??= createMarkdown();
  const { frontMatter, body } = splitFrontMatter(source.replace(/^\uFEFF/, ''));
  const front =
    frontMatter !== undefined
      ? `<div class="front-matter">${highlightCode(frontMatter, 'yaml') ?? `<pre><code>${escapeHtml(frontMatter)}</code></pre>`}</div>`
      : '';
  return front + markdown.render(body);
}

export interface InlineImagesOptions {
  /** Absolute path of the Markdown file. */
  filePath: string;
  /** Project root; images outside it are not read. */
  rootPath: string;
  readFile?: (path: string) => Promise<Buffer>;
  statSize?: (path: string) => Promise<number>;
}

const placeholder = (text: string, title: string) =>
  `<span class="image-placeholder" title="${escapeHtml(title)}">${escapeHtml(text)}</span>`;

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Replaces relative `<img src>` with `data:` URIs (≤ 5 MB per image, ≤ 20 MB per document); larger, missing,
 * remote or out-of-project images become placeholders with their name.
 */
export async function inlineImages(html: string, opts: InlineImagesOptions): Promise<string> {
  const read = opts.readFile ?? ((p: string) => readFile(p));
  const size = opts.statSize ?? (async (p: string) => (await stat(p)).size);
  const pattern = /<img\b[^>]*?\bsrc="([^"]*)"[^>]*>/gi;
  const matches = [...html.matchAll(pattern)];
  if (matches.length === 0) return html;
  const replacements = new Map<string, string>();
  let total = 0;
  for (const m of matches) {
    const tag = m[0];
    if (replacements.has(tag)) continue;
    const src = m[1]!.replace(/&amp;/g, '&');
    const alt = /\balt="([^"]*)"/i.exec(tag)?.[1] ?? '';
    if (/^data:image\//i.test(src)) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) {
      replacements.set(tag, placeholder(`🖼 ${alt || src}`, `Remote images are not loaded: ${src}`));
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(src.replace(/[?#].*$/, ''));
    } catch {
      decoded = src;
    }
    const target = decoded.startsWith('/') ? join(opts.rootPath, decoded) : resolve(dirname(opts.filePath), decoded);
    const name = basename(decoded) || decoded;
    const type = IMAGE_TYPES[extname(target).toLowerCase()];
    if (!isInside(opts.rootPath, target) || !type) {
      replacements.set(tag, placeholder(`🖼 ${name}`, `Image not shown: ${decoded}`));
      continue;
    }
    try {
      const bytes = await size(target);
      if (bytes > MAX_IMAGE_BYTES || total + bytes > MAX_DOCUMENT_IMAGE_BYTES) {
        replacements.set(tag, placeholder(`🖼 ${name} (too large)`, `${decoded}: ${(bytes / 1048576).toFixed(1)} MB`));
        continue;
      }
      const data = await read(target);
      total += data.length;
      replacements.set(tag, tag.replace(m[1]!, `data:${type};base64,${data.toString('base64')}`));
    } catch {
      replacements.set(tag, placeholder(`🖼 ${name} (not found)`, `Image not found: ${decoded}`));
    }
  }
  return html.replace(pattern, (tag) => replacements.get(tag) ?? tag);
}

/** Full render of a Markdown file: HTML with inlined images. */
export async function renderFile(filePath: string, rootPath: string): Promise<string> {
  const source = await readFile(filePath, 'utf8');
  return inlineImages(renderMarkdownToHtml(source), { filePath, rootPath });
}
