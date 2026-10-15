import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, posix, win32 } from 'node:path';
import { parse, TomlError } from 'smol-toml';
import { MCP_MAX_TIMEOUT_MS, MCP_SERVER_NAME, type McpCliResult } from '@shared/domain/mcp';
import { mcpUrl } from './client-registration';

/**
 * Codex CLI reads its MCP servers from `config.toml` in its home folder (`$CODEX_HOME`, else `~/.codex`) and has no
 * command that adds an HTTP server with headers, so Oxytocin edits the file itself: only the `[mcp_servers.oxytocin]`
 * table (and its sub-tables) is replaced or removed; everything else stays byte for byte, comments included.
 */

/** The environment variable Codex reads into the terminal header when it connects (`env_http_headers`). */
export const TERMINAL_ENV = 'OXYTOCIN_TERMINAL_ID';

/** Codex's home folder: `CODEX_HOME` (any case on Windows), else `~/.codex`. */
export function codexHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home = homedir()): string {
  const key = Object.keys(env).find((k) =>
    platform === 'win32' ? k.toUpperCase() === 'CODEX_HOME' : k === 'CODEX_HOME',
  );
  const value = key === undefined ? undefined : env[key]?.trim();
  return value || (platform === 'win32' ? win32 : posix).join(home, '.codex');
}

export const codexConfigPath = (home: string, platform: NodeJS.Platform): string =>
  (platform === 'win32' ? win32 : posix).join(home, 'config.toml');

const tomlString = (s: string): string => JSON.stringify(s);

/** The `[mcp_servers.oxytocin]` table (the token only opens the local server; tool calls may take up to 10 min). */
export function codexServerToml(port: number, token: string): string {
  return [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    "# Oxytocin's MCP server (Oxytocin → Settings → Agent Tools → Connect Codex).",
    `url = ${tomlString(mcpUrl(port))}`,
    `http_headers = { Authorization = ${tomlString(`Bearer ${token}`)} }`,
    `env_http_headers = { X-Oxytocin-Terminal = ${tomlString(TERMINAL_ENV)} }`,
    `tool_timeout_sec = ${MCP_MAX_TIMEOUT_MS / 1000}`,
  ].join('\n');
}

/** A table header's dotted key (`[a."b.c"]` → `['a', 'b.c']`); null when the line is no table header. */
export function headerPath(line: string): string[] | null {
  const m = /^\s*\[(\[?)(.*?)\](\]?)\s*(?:#.*)?$/.exec(line);
  if (!m || !m[1] !== !m[3]) return null;
  const raw = m[2]!;
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    while (raw[i] === ' ' || raw[i] === '\t') i++;
    let part: string;
    const quote = raw[i];
    if (quote === '"' || quote === "'") {
      let j = i + 1;
      while (j < raw.length && raw[j] !== quote) j += quote === '"' && raw[j] === '\\' ? 2 : 1;
      if (j >= raw.length) return null;
      part = raw.slice(i + 1, j);
      if (quote === '"') {
        try {
          part = JSON.parse(`"${part}"`) as string;
        } catch {
          return null;
        }
      }
      i = j + 1;
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(raw.slice(i));
      if (!bare) return null;
      part = bare[0];
      i += part.length;
    }
    parts.push(part);
    while (raw[i] === ' ' || raw[i] === '\t') i++;
    if (i >= raw.length) return parts;
    if (raw[i] !== '.') return null;
    i++;
  }
}

/** Opens or closes multi-line strings (`"""`, `'''`) on a line; returns the delimiter still open after it. */
function openString(line: string, open: string | null): string | null {
  let i = 0;
  let current = open;
  while (i < line.length) {
    if (current) {
      const end = line.indexOf(current, i);
      if (end < 0) return current;
      i = end + 3;
      current = null;
      continue;
    }
    const ch = line[i];
    if (ch === '#') return null;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      current = line.slice(i, i + 3);
      i += 3;
    } else if (ch === '"' || ch === "'") {
      // A single-line string: skip it (escapes only in basic strings).
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += ch === '"' && line[j] === '\\' ? 2 : 1;
      i = j + 1;
    } else i++;
  }
  return current;
}

const isOurs = (path: string[] | null): boolean =>
  path !== null && path.length >= 2 && path[0] === 'mcp_servers' && path[1] === MCP_SERVER_NAME;

const isBlank = (line: string): boolean => line.trim() === '';
const isComment = (line: string): boolean => line.trim().startsWith('#');

/**
 * The config without the `[mcp_servers.oxytocin]` table and its sub-tables (`block` appended at the end when given).
 * Comments right above the next table stay with it; the rest of the file is unchanged.
 */
export function withCodexServer(config: string, block: string | null): string {
  const eol = config.includes('\r\n') ? '\r\n' : '\n';
  const kept: string[] = [];
  let removed: string[] = [];
  let ours = false;
  let open: string | null = null;
  for (const line of config.split(/\r?\n/)) {
    if (!open) {
      const path = headerPath(line);
      if (path) {
        const next = isOurs(path);
        if (ours && !next) {
          // The comment block above the next table belongs to it.
          let i = removed.length;
          while (i > 1 && (isBlank(removed[i - 1]!) || isComment(removed[i - 1]!))) i--;
          while (i < removed.length && isBlank(removed[i]!)) i++;
          if (kept.length > 0 && !isBlank(kept[kept.length - 1]!) && i < removed.length) kept.push('');
          kept.push(...removed.slice(i));
        }
        if (!ours && next) removed = [];
        ours = next;
      }
    }
    open = openString(line, open);
    if (ours) removed.push(line);
    else kept.push(line);
  }
  let text = kept.join(eol).replace(/\s+$/, '');
  const add = block?.split('\n').join(eol);
  if (add) text = text ? `${text}${eol}${eol}${add}` : add;
  return text ? text + eol : '';
}

type Toml = Record<string, unknown>;
const isTable = (v: unknown): v is Toml => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseConfig(text: string): Toml {
  return parse(text.replace(/^\uFEFF/, ''));
}

/** The `oxytocin` server Codex knows (null: none). */
export function codexServer(config: Toml): { url?: string; authorization?: string } | null {
  const servers = config['mcp_servers'];
  const server = isTable(servers) ? servers[MCP_SERVER_NAME] : undefined;
  if (!isTable(server)) return null;
  const headers = isTable(server['http_headers']) ? server['http_headers'] : {};
  const auth = headers['Authorization'];
  return {
    ...(typeof server['url'] === 'string' ? { url: server['url'] } : {}),
    ...(typeof auth === 'string' ? { authorization: auth } : {}),
  };
}

const problem = (path: string, e: unknown): string =>
  e instanceof TomlError
    ? `${path} is not valid TOML (line ${e.line}): ${e.message.split('\n')[0]}. Fix it, then try again.`
    : `${path}: ${e instanceof Error ? e.message : String(e)}`;

export interface CodexConfigFs {
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export const nodeCodexFs: CodexConfigFs = {
  readText: (path) =>
    readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e))),
  async writeText(path, text) {
    await mkdir(dirname(path), { recursive: true });
    const mode = (await stat(path).catch(() => null))?.mode ?? 0o600;
    // Written next to it and renamed: Codex never reads half a file.
    const temp = `${path}.oxytocin-${process.pid}.tmp`;
    await writeFile(temp, text, { mode });
    await rename(temp, path);
  },
  exists: (path) =>
    stat(path).then(
      () => true,
      () => false,
    ),
};

/** Changes the `oxytocin` table of Codex's config (null removes it); checks the result before writing it. */
async function edit(fs: CodexConfigFs, path: string, block: string | null, port: number): Promise<McpCliResult> {
  let before: string | null;
  try {
    before = await fs.readText(path);
  } catch (e) {
    return { ok: false, output: problem(path, e) };
  }
  if (before === null && block === null) return { ok: true, output: `${path} does not exist.` };
  try {
    parseConfig(before ?? '');
  } catch (e) {
    return { ok: false, output: problem(path, e) };
  }
  const after = withCodexServer(before ?? '', block);
  let server: ReturnType<typeof codexServer>;
  try {
    server = codexServer(parseConfig(after));
  } catch {
    server = { url: '' };
  }
  const expected = block === null ? server === null : server?.url === mcpUrl(port);
  if (!expected)
    return {
      ok: false,
      output: `${path} defines the "${MCP_SERVER_NAME}" MCP server in a form Oxytocin cannot change. Remove it there, then try again.`,
    };
  if (after === before) return { ok: true, output: `${path} is up to date.` };
  try {
    await fs.writeText(path, after);
  } catch (e) {
    return { ok: false, output: problem(path, e) };
  }
  return { ok: true, output: block === null ? `Removed from ${path}.` : `Added to ${path}.` };
}

export function connectCodex(fs: CodexConfigFs, path: string, port: number, token: string): Promise<McpCliResult> {
  return edit(fs, path, codexServerToml(port, token), port);
}

export function disconnectCodex(fs: CodexConfigFs, path: string, port: number): Promise<McpCliResult> {
  return edit(fs, path, null, port);
}

/**
 * Whether Codex knows the server at this address with this token (null: could not tell — Codex's folder does not
 * exist, or its config is not valid TOML).
 */
export async function isConnectedToCodex(
  fs: CodexConfigFs,
  home: string,
  path: string,
  port: number,
  token: string,
): Promise<boolean | null> {
  const text = await fs.readText(path).catch(() => null);
  if (text === null) return (await fs.exists(home)) ? false : null;
  let server: ReturnType<typeof codexServer>;
  try {
    server = codexServer(parseConfig(text));
  } catch {
    return null;
  }
  return server?.url === mcpUrl(port) && server.authorization === `Bearer ${token}`;
}
