import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { MCP_SERVER_NAME, type McpCliResult } from '@shared/domain/mcp';
import { shouldStripInherited } from '../terminals/env-composer';

/** Name of the Project Runner's own server before the hub (`oxytocin-runner`, Oxytocin ≤ 0.6.0). */
export const LEGACY_RUNNER_SERVER_NAME = 'oxytocin-runner';

/**
 * Header naming the terminal an agent runs in. Claude Code expands `${VAR:-default}` in the headers of a user-scope
 * HTTP server when it connects (verified with Claude Code 2.1.285); outside Oxytocin the default `none` arrives.
 */
export const TERMINAL_HEADER = 'X-Oxytocin-Terminal: ${OXYTOCIN_TERMINAL_ID:-none}';

export type RunCli = (args: string[]) => Promise<McpCliResult>;

/** PATH plus the usual install folders of Claude Code (the app may have been started without a login shell). */
export function cliPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home = homedir()): string {
  const path = platform === 'win32' ? win32 : posix;
  const join = (...parts: string[]) => path.join(...parts);
  const extra =
    platform === 'win32'
      ? [join(home, '.local', 'bin'), ...(env['APPDATA'] ? [join(env['APPDATA'], 'npm')] : [])]
      : [join(home, '.local', 'bin'), join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin'];
  const current = env['PATH'] ?? env['Path'] ?? '';
  return [current, ...extra].filter(Boolean).join(platform === 'win32' ? ';' : ':');
}

/** The CLI's environment: the shell environment without Oxytocin's own or a parent Claude Code's variables. */
export function cliEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (!shouldStripInherited(key, { dev: false })) out[key] = value;
  for (const key of Object.keys(out)) if (key.toUpperCase() === 'PATH') delete out[key];
  out[platform === 'win32' ? 'Path' : 'PATH'] = cliPath(env, platform);
  return out;
}

/** cmd.exe quoting (Windows runs `claude.cmd` through a shell). */
export const quoteWin = (arg: string): string => (/[\s"&|<>^%]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg);

export function createCliRunner(
  command: () => string,
  env: () => NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): RunCli {
  return (args) =>
    new Promise((resolve) => {
      const win = platform === 'win32';
      execFile(
        win ? quoteWin(command()) : command(),
        win ? args.map(quoteWin) : args,
        {
          env: cliEnv(env(), platform),
          timeout: 60_000,
          windowsHide: true,
          shell: win,
          maxBuffer: 4 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const output = `${stdout}${stderr}`.trim();
          if (error && (error as NodeJS.ErrnoException).code === 'ENOENT')
            resolve({ ok: false, output: `${command()} was not found. Set "mcp.claudeCommand" to its path.` });
          else resolve({ ok: !error, output: output || (error ? error.message : '') });
        },
      );
    });
}

export const mcpUrl = (port: number): string => `http://127.0.0.1:${port}/mcp`;

/** Arguments of `claude mcp add` (user scope: every project, every session). */
export function addArgs(port: number, token: string): string[] {
  return [
    'mcp',
    'add',
    '--scope',
    'user',
    '--transport',
    'http',
    MCP_SERVER_NAME,
    mcpUrl(port),
    '--header',
    `Authorization: Bearer ${token}`,
    '--header',
    TERMINAL_HEADER,
  ];
}

/** The same as a command line to copy into a POSIX shell (the token only opens the local server). */
export function addCommandLine(port: number, token: string): string {
  return `claude ${addArgs(port, token)
    .map((a) => (/[\s"$]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a))
    .join(' ')}`;
}

/** `mcpServers` JSON for other MCP clients (Cursor, Windsurf, Claude Desktop through a bridge, …). */
export function mcpConfigJson(port: number, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_NAME]: { type: 'http', url: mcpUrl(port), headers: { Authorization: `Bearer ${token}` } },
      },
    },
    null,
    2,
  );
}

export interface ConnectResult extends McpCliResult {
  /** The old `oxytocin-runner` registration was removed. */
  migrated: boolean;
}

/**
 * Registers (or re-registers, e.g. after a port or token change) the server in Claude Code. The Project Runner's old
 * `oxytocin-runner` server is removed at the same time: its tools are now part of this server.
 */
export async function connectClaude(run: RunCli, port: number, token: string): Promise<ConnectResult> {
  await run(['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME]);
  const result = await run(addArgs(port, token));
  if (!result.ok) return { ...result, migrated: false };
  const legacy = await run(['mcp', 'get', LEGACY_RUNNER_SERVER_NAME]);
  if (!legacy.ok) return { ...result, migrated: false };
  const removed = await run(['mcp', 'remove', '--scope', 'user', LEGACY_RUNNER_SERVER_NAME]);
  return { ...result, migrated: removed.ok };
}

export function disconnectClaude(run: RunCli): Promise<McpCliResult> {
  return run(['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME]);
}

/**
 * Whether Claude Code knows the server at the current address (null = could not tell, e.g. Claude Code is not
 * installed). A registration with another port counts as not connected.
 */
export async function isConnectedToClaude(run: RunCli, port: number): Promise<boolean | null> {
  const r = await run(['mcp', 'get', MCP_SERVER_NAME]);
  if (r.ok) return r.output.includes(mcpUrl(port));
  return /no mcp server/i.test(r.output) ? false : null;
}
