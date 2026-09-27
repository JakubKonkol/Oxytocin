import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStatusLineInput, STATUSLINE_DATA_FILE } from './collectors/claude-statusline';
import {
  findGitBash,
  installStatusLine,
  isStatusLineInstalled,
  statusLineCommand,
  statusLinePaths,
  uninstallStatusLine,
} from './statusline-install';

async function setup(settings?: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'oxy-claude-config-'));
  const paths = statusLinePaths({ CLAUDE_CONFIG_DIR: root });
  if (settings !== undefined)
    await writeFile(paths.settingsFile, typeof settings === 'string' ? settings : JSON.stringify(settings));
  const read = async () => JSON.parse(await readFile(paths.settingsFile, 'utf8')) as Record<string, unknown>;
  return { root, paths, read };
}

describe('Claude Code status line setup', () => {
  it('uses the first CLAUDE_CONFIG_DIR folder, else ~/.claude', () => {
    expect(statusLinePaths({ CLAUDE_CONFIG_DIR: ' /a , /b' }, '/home/u').dir).toBe(join('/a', 'oxytocin-statusline'));
    expect(statusLinePaths({}, '/home/u').settingsFile).toBe(join('/home/u', '.claude', 'settings.json'));
  });

  it('builds commands with forward slashes for Git Bash and PowerShell', () => {
    expect(statusLineCommand('C:\\Users\\a b\\.claude\\oxytocin-statusline', 'sh')).toBe(
      "sh 'C:/Users/a b/.claude/oxytocin-statusline/statusline.sh'",
    );
    expect(statusLineCommand('C:\\Users\\a\\.claude\\oxytocin-statusline', 'powershell')).toBe(
      'powershell -NoProfile -ExecutionPolicy Bypass -File "C:/Users/a/.claude/oxytocin-statusline/statusline.ps1"',
    );
  });

  it('wraps an existing status line, keeps other settings and restores everything on removal', async () => {
    const original = { type: 'command', command: '~/.claude/mine.sh', padding: 2 };
    const { paths, read } = await setup({ model: 'opus', statusLine: original });
    await installStatusLine(paths, 'sh');
    const installed = await read();
    expect(installed['model']).toBe('opus');
    expect(installed['statusLine']).toEqual({
      type: 'command',
      command: statusLineCommand(paths.dir, 'sh'),
      padding: 2,
    });
    expect(await readFile(join(paths.dir, 'original-command'), 'utf8')).toBe('~/.claude/mine.sh');
    expect(await isStatusLineInstalled(paths)).toBe(true);

    // Setting it up again (another shell) keeps the backup of the user's status line.
    await installStatusLine(paths, 'powershell');
    expect((await read())['statusLine']).toMatchObject({ command: statusLineCommand(paths.dir, 'powershell') });

    expect(await uninstallStatusLine(paths)).toBe(true);
    expect(await read()).toEqual({ model: 'opus', statusLine: original });
    expect(await isStatusLineInstalled(paths)).toBe(false);
    expect(await uninstallStatusLine(paths)).toBe(false);
  });

  it('creates the settings file when missing and removes the entry again', async () => {
    const { paths, read } = await setup();
    await installStatusLine(paths, 'sh');
    expect((await read())['statusLine']).toEqual({ type: 'command', command: statusLineCommand(paths.dir, 'sh') });
    await uninstallStatusLine(paths);
    expect(await read()).toEqual({});
  });

  it('leaves a status line the user set in the meantime alone', async () => {
    const { paths, read } = await setup({});
    await installStatusLine(paths, 'sh');
    const theirs = { type: 'command', command: 'echo new' };
    await writeFile(paths.settingsFile, JSON.stringify({ statusLine: theirs }));
    expect(await uninstallStatusLine(paths)).toBe(false);
    expect((await read())['statusLine']).toEqual(theirs);
  });

  it('never overwrites an unreadable settings file', async () => {
    const { paths } = await setup('{ "statusLine": ');
    await expect(installStatusLine(paths, 'sh')).rejects.toThrow();
    expect(await readFile(paths.settingsFile, 'utf8')).toBe('{ "statusLine": ');
    // Nothing of ours to undo → no error.
    expect(await uninstallStatusLine(paths)).toBe(false);
  });

  it('finds Git Bash from CLAUDE_CODE_GIT_BASH_PATH, Git on PATH or the default folders', async () => {
    const files = new Set([win32.join('C:\\Git\\cmd', 'git.exe'), win32.join('C:\\Git\\cmd', '..', 'bin', 'bash.exe')]);
    const isFile = (p: string) => Promise.resolve(files.has(p));
    expect(await findGitBash({ PATH: 'C:\\Git\\cmd' }, isFile)).toBe(
      win32.join('C:\\Git\\cmd', '..', 'bin', 'bash.exe'),
    );
    expect(await findGitBash({ PATH: '' }, isFile)).toBeNull();
    files.add('D:\\bash.exe');
    expect(await findGitBash({ CLAUDE_CODE_GIT_BASH_PATH: 'D:\\bash.exe' }, isFile)).toBe('D:\\bash.exe');
  });
});

describe('the status line script', async () => {
  const shell = process.platform === 'win32' ? await findGitBash(process.env) : 'sh';
  it.skipIf(!shell)('saves input with rate limits and runs the previous command with the same input', async () => {
    const { paths } = await setup({ statusLine: { type: 'command', command: 'cat' } });
    await installStatusLine(paths, 'sh');
    const script = join(paths.dir, 'statusline.sh');
    const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 7, resets_at: 2e9 } } });
    const result = spawnSync(shell!, [script], { input, encoding: 'utf8' });
    expect(result.stdout).toBe(input);
    const saved = await readFile(join(paths.dir, STATUSLINE_DATA_FILE), 'utf8');
    expect(parseStatusLineInput(saved, 1)).toEqual([expect.objectContaining({ usedPercent: 7 })]);

    // Input without limits (API billing) is not saved.
    const other = JSON.stringify({ session_id: 'x' });
    expect(spawnSync(shell!, [script], { input: other, encoding: 'utf8' }).stdout).toBe(other);
    expect(await readFile(join(paths.dir, STATUSLINE_DATA_FILE), 'utf8')).toBe(saved);
  });

  it.skipIf(process.platform !== 'win32')(
    'PowerShell variant: saves UTF-8 input and runs a quoted command',
    async () => {
      const previous = 'Write-Output ("mine: " + [Console]::In.ReadToEnd().Trim().Length)';
      const { paths, read } = await setup({ statusLine: { type: 'command', command: previous } });
      await installStatusLine(paths, 'powershell');
      const command = ((await read())['statusLine'] as { command: string }).command;
      const input = JSON.stringify({ rate_limits: { seven_day: { used_percentage: 9 } }, cwd: 'C:\\żółw' });
      const result = spawnSync(command, { input, encoding: 'utf8', shell: 'powershell.exe' });
      expect(result.stdout.trim()).toBe(`mine: ${input.length}`);
      expect(await readFile(join(paths.dir, STATUSLINE_DATA_FILE), 'utf8')).toBe(input);
    },
    30_000,
  );
});
