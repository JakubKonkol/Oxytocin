import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn as ptySpawn } from 'node-pty';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  injectShellIntegration,
  installShellIntegration,
  type ShellIntegrationScripts,
} from '../../src/main/services/terminals/shell-integration';
import type { ShellType } from '../../src/main/services/terminals/profiles';
import { TerminalManager } from '../../src/pty-host/terminal-manager';
import { silentLogger } from '../helpers/logger';

type CommandEvent = { phase: string; commandLine?: string; exitCode?: number; durationMs?: number };

const has = (bin: string) => {
  if (process.platform === 'win32') return false;
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

let scripts: ShellIntegrationScripts;
let home: string;
let manager: TerminalManager | undefined;
let events: { name: string; payload: Record<string, unknown> }[];

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oxy-si-'));
  scripts = await installShellIntegration(resolve(__dirname, '../../resources/shell-integration'), dir);
  // A clean home: user rc files that print or change prompts must not interfere.
  home = await realpath(await mkdtemp(join(tmpdir(), 'oxy-si-home-')));
  await writeFile(join(home, '.bashrc'), 'PS1="bashrc> "\nexport FROM_BASHRC=1\n');
  await writeFile(join(home, '.bash_profile'), '. "$HOME/.bashrc"\nexport FROM_LOGIN=1\n');
  await writeFile(join(home, '.zshrc'), 'PS1="zshrc> "\nexport FROM_ZSHRC=1\n');
  // Debian/Ubuntu's global zshrc runs compinit, which asks about "insecure directories" on some CI images.
  await writeFile(join(home, '.zshenv'), 'skip_global_compinit=1\nexport FROM_ZSHENV=1\n');
  await mkdir(join(home, '.config/fish'), { recursive: true });
  await writeFile(join(home, '.config/fish/config.fish'), 'set -gx FROM_FISH_CONFIG 1\n');
});

afterEach(async () => {
  await manager?.shutdown(500);
  manager = undefined;
});

function start(shellType: ShellType, file: string, args: string[], initialCommand?: string): string {
  events = [];
  manager = new TerminalManager({
    spawnPty: (f, a, o) => ptySpawn(f, a, o),
    emit: (name, payload) => events.push({ name, payload: payload as Record<string, unknown> }),
    logger: silentLogger,
  });
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: home,
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    XDG_CONFIG_HOME: join(home, '.config'),
  };
  const injection = injectShellIntegration({ shellType, args, env, scripts, platform: process.platform });
  expect(injection.injected).toBe(true);
  const id = `si-${shellType}-${Date.now()}`;
  manager.spawn({
    id,
    file,
    args: injection.args,
    cwd: home,
    env: injection.env,
    cols: 100,
    rows: 30,
    scrollback: 1000,
    shellIntegration: true,
    ...(initialCommand ? { initialCommand } : {}),
  });
  return id;
}

const commands = () =>
  events.filter((e) => e.name === 'terminal:command').map((e) => e.payload as unknown as CommandEvent);
const cwds = () => events.filter((e) => e.name === 'terminal:cwd').map((e) => e.payload['cwd'] as string);

async function waitFor(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(events)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function exercise(id: string, marker: string) {
  // The initial command ran after the first prompt, and its end was reported.
  await waitFor(
    () => commands().some((c) => c.phase === 'end' && c.commandLine === `echo ${marker}` && c.exitCode === 0),
    'the initial command',
  );
  expect(commands()[0]).toMatchObject({ phase: 'prompt' });
  expect(cwds()).toContain(home);
  const text = await manager!.getText(id);
  expect(text).toContain(marker);

  manager!.write(id, 'cd /tmp\r');
  await waitFor(() => cwds().includes('/tmp'), 'the new cwd');
  manager!.write(id, 'false\r');
  await waitFor(() => commands().some((c) => c.phase === 'end' && c.commandLine === 'false'), 'a failing command');
  const failed = commands().find((c) => c.phase === 'end' && c.commandLine === 'false')!;
  expect(failed.exitCode).toBe(1);
  expect(failed.durationMs).toBeGreaterThanOrEqual(0);

  // Enter on an empty line is not a command.
  const before = commands().filter((c) => c.phase === 'start').length;
  const prompts = commands().filter((c) => c.phase === 'prompt').length;
  manager!.write(id, '\r');
  await waitFor(() => commands().filter((c) => c.phase === 'prompt').length > prompts, 'another prompt');
  expect(commands().filter((c) => c.phase === 'start').length).toBe(before);
  // A command line with a separator is reported unescaped.
  manager!.write(id, 'echo a; echo b\r');
  await waitFor(() => commands().some((c) => c.phase === 'start' && c.commandLine === 'echo a; echo b'), 'the line');
}

describe.skipIf(!has('bash'))('shell integration: bash', () => {
  it('reports prompts, commands, exit codes and cwd; emulates a login shell', async () => {
    const id = start('bash', 'bash', ['-l'], 'echo bash-$FROM_LOGIN-$FROM_BASHRC-ok');
    await waitFor(() => commands().some((c) => c.phase === 'end'), 'the initial command');
    expect(await manager!.getText(id)).toContain('bash-1-1-ok');
    const text = await manager!.getText(id);
    expect(text).toContain('bashrc> ');
    manager!.write(id, 'echo marker-bash\r');
    await exercise(id, 'marker-bash');
  });
});

describe.skipIf(!has('zsh'))('shell integration: zsh', () => {
  it('reports prompts, commands, exit codes and cwd through ZDOTDIR', async () => {
    const id = start('zsh', 'zsh', ['-l'], 'echo zsh-$FROM_ZSHENV-$FROM_ZSHRC-ok');
    await waitFor(() => commands().some((c) => c.phase === 'end'), 'the initial command');
    expect(await manager!.getText(id)).toContain('zsh-1-1-ok');
    manager!.write(id, 'echo marker-zsh\r');
    await exercise(id, 'marker-zsh');
    manager!.write(id, 'echo "zdotdir=[$ZDOTDIR]"\r');
    await waitFor(
      () => commands().some((c) => c.commandLine?.startsWith('echo "zdotdir') && c.phase === 'end'),
      'zdotdir',
    );
    expect(await manager!.getText(id)).toContain('zdotdir=[]');
  });
});

describe.skipIf(!has('fish'))('shell integration: fish', () => {
  it('reports prompts, commands, exit codes and cwd through vendor_conf.d', async () => {
    const id = start('fish', 'fish', ['-l'], 'echo fish-$FROM_FISH_CONFIG-ok');
    await waitFor(() => commands().some((c) => c.phase === 'end'), 'the initial command', 15_000);
    expect(await manager!.getText(id)).toContain('fish-1-ok');
    manager!.write(id, 'echo marker-fish\r');
    await exercise(id, 'marker-fish');
  });
});
