export interface FileLinkMatch {
  /** Start index in the line (0-based, UTF-16 code units). */
  start: number;
  /** Length of the whole link text (path + position suffix). */
  length: number;
  path: string;
  line?: number;
  column?: number;
}

// Typographic quotes („CLAUDE.md”, “a.ts”, «x.md») separate tokens like ASCII quotes do.
const TOKEN = /[^\s'"`()<>[\]{},;|„”“‘’«»]+(?:\(\d+(?:,\d+)?\))?/g;
const HAS_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;

function parsePosition(token: string): { path: string; line?: number; column?: number } {
  // MSBuild / tsc: file(line,col)
  const paren = /^(.+?)\((\d+)(?:,(\d+))?\)$/.exec(token);
  if (paren) {
    return { path: paren[1]!, line: Number(paren[2]), ...(paren[3] ? { column: Number(paren[3]) } : {}) };
  }
  // file:line:col / file:line (a Windows drive colon is never followed by digits only)
  const colon = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(token)!;
  return {
    path: colon[1]!,
    ...(colon[2] ? { line: Number(colon[2]) } : {}),
    ...(colon[3] ? { column: Number(colon[3]) } : {}),
  };
}

/**
 * Finds file-like references in a terminal line: `src/app.ts:12:3`, `C:\x\y.js:10`, `a.tsx(5,10)`,
 * `package.json`. Candidates still need an existence check (fs:statMany) before becoming links.
 */
export function findFileLinks(text: string): FileLinkMatch[] {
  const out: FileLinkMatch[] = [];
  for (const m of text.matchAll(TOKEN)) {
    let token = m[0];
    const start = m.index;
    // Trailing punctuation from prose ("see a.ts." / "a.ts:").
    token = token.replace(/[.:]+$/, '');
    if (token.includes('://')) continue;
    const parsed = parsePosition(token);
    const name = parsed.path.split(/[\\/]/).at(-1) ?? '';
    if (!HAS_EXTENSION.test(name) || name.length < 3) continue;
    out.push({ start, length: token.length, ...parsed });
  }
  return out;
}

/** Path of a `file://` URI (OSC 8 hyperlinks); `#L12` / `#12` fragments become the line. Null for other URIs. */
export function fileUriToPath(uri: string): { path: string; line?: number } | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== 'file:') return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  // file:///C:/work/a.ts → C:/work/a.ts; file://server/share/a.ts → //server/share/a.ts (UNC).
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  else if (url.host && url.host !== 'localhost') path = `//${url.host}${path}`;
  if (!path) return null;
  const line = /^#L?(\d+)/i.exec(url.hash)?.[1];
  return { path, ...(line ? { line: Number(line) } : {}) };
}

/** Whether `path` lies inside `root` (both absolute; case-insensitive when asked, any separator). */
export function isInsideRoot(root: string, path: string, caseInsensitive: boolean): boolean {
  const norm = (p: string) => {
    const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return caseInsensitive ? s.toLowerCase() : s;
  };
  const r = norm(root);
  const p = norm(path);
  return p === r || p.startsWith(`${r}/`);
}
