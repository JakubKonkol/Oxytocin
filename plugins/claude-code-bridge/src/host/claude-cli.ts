import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { INSTALL_ID, MARKETPLACE_NAME } from './claude-plugin';

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
            resolve({ ok: false, output: `${command()} was not found. Set "claudeBridge.claudeCommand" to its path.` });
          else resolve({ ok: !error, output: output || (error ? error.message : '') });
        },
      );
    });
}

/** Registers the local marketplace and installs the bridge plugin for the user (Claude Code user settings). */
export async function installInClaude(run: RunCli, marketplaceDir: string): Promise<CliResult> {
  const added = await run(['plugin', 'marketplace', 'add', marketplaceDir]);
  if (!added.ok && !/already/i.test(added.output)) return added;
  const installed = await run(['plugin', 'install', INSTALL_ID, '--scope', 'user']);
  // Installed before: refresh Claude Code's copy (e.g. after a port change).
  if (!installed.ok && /already/i.test(installed.output)) return refreshInClaude(run);
  return installed;
}

/** Copies the current hooks into Claude Code's plugin cache (new sessions use them). */
export function refreshInClaude(run: RunCli): Promise<CliResult> {
  return run(['plugin', 'update', INSTALL_ID]);
}

/** Removing the marketplace also uninstalls its plugins. */
export function removeFromClaude(run: RunCli): Promise<CliResult> {
  return run(['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
}

/** Whether Claude Code lists the bridge as installed and enabled (null = could not tell). */
export async function isInstalledInClaude(run: RunCli): Promise<boolean | null> {
  const listed = await run(['plugin', 'list', '--json']);
  if (!listed.ok) return null;
  try {
    const start = listed.output.indexOf('[');
    const list = JSON.parse(listed.output.slice(start)) as { id?: string; enabled?: boolean }[];
    return list.some((p) => p.id === INSTALL_ID && p.enabled !== false);
  } catch {
    return null;
  }
}
