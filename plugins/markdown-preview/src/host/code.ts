import { open, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { highlightLines } from './highlight';

/** Files larger than this are not previewed (the editor is the better tool). */
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
/** Above this size (or line count) code is shown as plain text: highlighting would stall the Plugin Host. */
export const MAX_HIGHLIGHT_BYTES = 512 * 1024;
export const MAX_HIGHLIGHT_LINES = 20_000;

export const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdx'];

/** Extension → shiki language of the preview (the languages loaded in highlight.ts). */
const LANGUAGES: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'jsx',
  '.json': 'json',
  '.jsonc': 'jsonc',
  '.json5': 'jsonc',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.htm': 'html',
  '.vue': 'html',
  '.svelte': 'html',
  '.xml': 'xml',
  '.svg': 'xml',
  '.csproj': 'xml',
  '.fsproj': 'xml',
  '.vbproj': 'xml',
  '.props': 'xml',
  '.targets': 'xml',
  '.xaml': 'xml',
  '.resx': 'xml',
  '.config': 'xml',
  '.plist': 'xml',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.conf': 'ini',
  '.env': 'ini',
  '.properties': 'ini',
  '.editorconfig': 'ini',
  '.py': 'python',
  '.pyi': 'python',
  '.cs': 'csharp',
  '.csx': 'csharp',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.gradle': 'kotlin',
  '.swift': 'swift',
  '.php': 'php',
  '.rb': 'ruby',
  '.sh': 'shellscript',
  '.bash': 'shellscript',
  '.zsh': 'shellscript',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.psd1': 'powershell',
  '.sql': 'sql',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.diff': 'diff',
  '.patch': 'diff',
};

/** Previewed as plain text (no highlighting). */
const PLAIN_EXTENSIONS = [
  '.txt',
  '.log',
  '.csv',
  '.tsv',
  '.lock',
  '.gitignore',
  '.dockerignore',
  '.gitattributes',
  '.npmrc',
  '.nvmrc',
  '.sln',
  '.slnx',
  '.graphql',
  '.gql',
  '.proto',
  '.tf',
  '.dart',
  '.lua',
  '.r',
  '.scala',
  '.ex',
  '.exs',
  '.erl',
  '.hs',
  '.clj',
  '.less',
  '.sass',
  '.styl',
  '.astro',
  '.razor',
  '.cshtml',
  '.vb',
  '.fs',
  '.bat',
  '.cmd',
];

/** Well-known extension-less file names. */
const NAMES: Record<string, string | null> = {
  dockerfile: 'dockerfile',
  makefile: null,
  license: null,
  procfile: null,
  gemfile: 'ruby',
  rakefile: 'ruby',
};

export type PreviewKind = { kind: 'markdown' } | { kind: 'code'; language: string | null };

/** How a file is previewed, or null when it is not a text format the preview knows. */
export function previewKind(path: string): PreviewKind | null {
  const ext = extname(path).toLowerCase();
  if (MARKDOWN_EXTENSIONS.includes(ext)) return { kind: 'markdown' };
  if (ext in LANGUAGES) return { kind: 'code', language: LANGUAGES[ext]! };
  if (PLAIN_EXTENSIONS.includes(ext)) return { kind: 'code', language: null };
  const name = basename(path).toLowerCase();
  if (name in NAMES) return { kind: 'code', language: NAMES[name]! };
  if (/^dockerfile\./.test(name) || name.endsWith('.dockerfile')) return { kind: 'code', language: 'dockerfile' };
  // Dotfiles such as `.env.local`, `.eslintrc`: plain text.
  if (/^\.env(\.|$)/.test(name)) return { kind: 'code', language: 'ini' };
  return null;
}

/** Every extension the preview handles (the file opener's list). */
export const PREVIEW_EXTENSIONS = [...MARKDOWN_EXTENSIONS, ...Object.keys(LANGUAGES), ...PLAIN_EXTENSIONS];

/** A NUL byte in the first 8 KB marks a binary file. */
export function looksBinary(head: Buffer): boolean {
  return head.subarray(0, 8192).includes(0);
}

export class PreviewError extends Error {}

/** Reads a text file for the preview; rejects with `PreviewError` for large or binary files. */
export async function readPreviewText(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile()) throw new PreviewError('Not a file.');
  if (info.size > MAX_PREVIEW_BYTES)
    throw new PreviewError(
      `The file is too large to preview (${(info.size / 1048576).toFixed(1)} MB, the limit is 2 MB). Open it in the editor.`,
    );
  const handle = await open(path, 'r');
  try {
    const buffer = await handle.readFile();
    if (looksBinary(buffer)) throw new PreviewError('Binary file — nothing to preview. Open it in the editor.');
    return buffer.toString('utf8').replace(/^\uFEFF/, '');
  } finally {
    await handle.close();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A code file as HTML: one `<span class="line">` per line inside `<pre class="code-view">` (line numbers come from
 * CSS counters, the view scrolls to a line by index). Highlighted when the language is known and the file is small.
 */
export function renderCodeToHtml(source: string, language: string | null): string {
  const text = source.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  const plain = () => text.split('\n').map((l) => escapeHtml(l));
  const highlight =
    language && text.length <= MAX_HIGHLIGHT_BYTES && text.split('\n').length <= MAX_HIGHLIGHT_LINES
      ? highlightLines(text, language)
      : undefined;
  const lines = highlight ?? plain();
  const body = lines.map((l) => `<span class="line">${l || ' '}</span>`).join('\n');
  const lang = highlight && language ? ` data-language="${language}"` : '';
  return `<pre class="code-view${highlight ? ' shiki oxytocin' : ''}"${lang}><code>${body}</code></pre>`;
}
