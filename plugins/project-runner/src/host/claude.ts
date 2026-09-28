import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Name of the MCP server in Claude Code (`claude mcp list`). */
export const MCP_SERVER_NAME = 'oxytocin-runner';

export interface CliResult {
  ok: boolean;
  output: string;
}

export type RunCli = (args: string[]) => Promise<CliResult>;

/** PATH plus the usual install folders of Claude Code (the app may have been started without a login shell). */
export function cliPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home = homedir()): string {
  const extra =
    platform === 'win32'
      ? [join(home, '.local', 'bin'), ...(env['APPDATA'] ? [join(env['APPDATA'], 'npm')] : [])]
      : [join(home, '.local', 'bin'), join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin'];
  const current = env['PATH'] ?? env['Path'] ?? '';
  return [current, ...extra].filter(Boolean).join(delimiter);
}

/** cmd.exe quoting (Windows runs `claude.cmd` through a shell). */
const quoteWin = (arg: string) => (/[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg);

export function createCliRunner(command: () => string, platform: NodeJS.Platform = process.platform): RunCli {
  return (args) =>
    new Promise((resolve) => {
      const win = platform === 'win32';
      const env = { ...process.env, PATH: cliPath(process.env, platform) };
      execFile(
        win ? quoteWin(command()) : command(),
        win ? args.map(quoteWin) : args,
        { env, timeout: 60_000, windowsHide: true, shell: win, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const output = `${stdout}${stderr}`.trim();
          if (error && (error as NodeJS.ErrnoException).code === 'ENOENT')
            resolve({
              ok: false,
              output: `${command()} was not found. Set "projectRunner.claudeCommand" to its path.`,
            });
          else resolve({ ok: !error, output: output || (error ? error.message : '') });
        },
      );
    });
}

export const mcpUrl = (port: number) => `http://127.0.0.1:${port}/mcp`;

/** Arguments of `claude mcp add` for the runner (user scope: every project, every session). */
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
  ];
}

/** The same as a command line to copy (token included — it only opens the local server). */
export function addCommandLine(port: number, token: string): string {
  return `claude ${addArgs(port, token)
    .map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(' ')}`;
}

/** `mcpServers` JSON for other MCP clients (Codex, Cursor, …). */
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

/** Registers (or re-registers, e.g. after a port change) the server in Claude Code. */
export async function connectClaude(run: RunCli, port: number, token: string): Promise<CliResult> {
  await run(['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME]);
  return run(addArgs(port, token));
}

export function disconnectClaude(run: RunCli): Promise<CliResult> {
  return run(['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME]);
}

/** Whether Claude Code knows the server (null = could not tell, e.g. Claude Code is not installed). */
export async function isConnectedToClaude(run: RunCli): Promise<boolean | null> {
  const r = await run(['mcp', 'get', MCP_SERVER_NAME]);
  if (r.ok) return true;
  return /not found|no mcp server/i.test(r.output) ? false : null;
}
