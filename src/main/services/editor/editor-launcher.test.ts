import { describe, expect, it, vi } from 'vitest';
import { resolveSettings } from '@shared/domain/settings';
import { cmdLine, expandArgs, parseCommandTemplate, quoteCmdArg, quoteForShell } from './command-template';
import { EditorLauncher, type EditorLauncherDeps, relativeTo } from './editor-launcher';

describe('command templates', () => {
  it('parses quoted arguments without escape sequences', () => {
    expect(parseCommandTemplate('code --goto ${file}:${line}')).toEqual(['code', '--goto', '${file}:${line}']);
    expect(parseCommandTemplate('"C:\\Program Files\\Ed\\ed.exe" -n${line} \'a b\' ""')).toEqual([
      'C:\\Program Files\\Ed\\ed.exe',
      '-n${line}',
      'a b',
      '',
    ]);
    expect(() => parseCommandTemplate('code "unterminated')).toThrow(/quote/);
  });

  it('substitutes placeholders per argument (no injection through file names)', () => {
    const vars = { file: '/p/a b; rm -rf ~.txt', line: 3, column: 7, projectRoot: '/p' };
    expect(expandArgs(['--goto', '${file}:${line}:${column}', '${projectRoot}'], vars)).toEqual([
      '--goto',
      '/p/a b; rm -rf ~.txt:3:7',
      '/p',
    ]);
  });

  it('quotes arguments for cmd.exe', () => {
    expect(quoteCmdArg('C:\\a b\\x.ts:3:1')).toBe('^"C:\\a^ b\\x.ts:3:1^"');
    expect(quoteCmdArg('a&b|c%PATH%^')).toBe('^"a^&b^|c^%PATH^%^^^"');
    expect(quoteCmdArg('say "hi"')).toBe('^"say^ \\^"hi\\^"^"');
    expect(quoteCmdArg('ends\\')).toBe('^"ends\\\\^"');
    expect(cmdLine('C:\\bin\\code.cmd', ['--goto', 'x.ts:1:1'])).toBe('"C:\\bin\\code.cmd ^"--goto^" ^"x.ts:1:1^""');
  });

  it('quotes for shells in the terminal preset', () => {
    expect(quoteForShell('/p/a.ts', 'posix')).toBe('/p/a.ts');
    expect(quoteForShell("/p/it's.ts", 'posix')).toBe("'/p/it'\\''s.ts'");
    expect(quoteForShell("C:\\p q\\it's.ts", 'pwsh')).toBe("'C:\\p q\\it''s.ts'");
    expect(quoteForShell('C:\\p q\\"x".ts', 'cmd')).toBe('"C:\\p q\\""x"".ts"');
  });
});

function launcher(settings: Record<string, unknown>, opts: Partial<EditorLauncherDeps> & { onPath?: string[] } = {}) {
  const onPath = new Set(opts.onPath ?? []);
  const deps: EditorLauncherDeps = {
    settings: () => resolveSettings(settings, 'linux').settings,
    projectFor: () => ({ id: 'p', rootPath: '/proj' }),
    which: (name) => Promise.resolve(onPath.has(name) ? `/usr/bin/${name}` : name.startsWith('C:') ? null : null),
    isFile: () => Promise.resolve(true),
    spawn: vi.fn(),
    openPath: vi.fn(() => Promise.resolve('')),
    openInTerminal: vi.fn(),
    openBuiltin: vi.fn(),
    platform: 'linux',
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    ...opts,
  };
  return { launcher: new EditorLauncher(deps), deps };
}

describe('EditorLauncher', () => {
  const req = { path: '/proj/src/a.ts', line: 12, column: 4 };

  it('auto-detects the first installed editor and falls back to the system app', async () => {
    expect(await launcher({}, { onPath: ['subl', 'cursor'] }).launcher.plan(req)).toEqual({
      kind: 'spawn',
      file: '/usr/bin/cursor',
      args: ['--goto', '/proj/src/a.ts:12:4'],
    });
    expect(await launcher({}).launcher.plan(req)).toEqual({ kind: 'system', path: '/proj/src/a.ts' });
  });

  it('uses explicit presets, JetBrains launchers in order, and custom templates', async () => {
    expect(await launcher({ 'editor.preset': 'jetbrains' }, { onPath: ['pycharm'] }).launcher.plan(req)).toEqual({
      kind: 'spawn',
      file: '/usr/bin/pycharm',
      args: ['--line', '12', '--column', '4', '/proj/src/a.ts'],
    });
    expect(
      await launcher(
        { 'editor.preset': 'custom', 'editor.command': 'myed "+${line}" ${file}' },
        { onPath: ['myed'] },
      ).launcher.plan(req),
    ).toEqual({ kind: 'spawn', file: '/usr/bin/myed', args: ['+12', '/proj/src/a.ts'] });
    // A project's own editor command wins.
    const own = launcher({}, { projectFor: () => ({ id: 'p', rootPath: '/proj', editorCommand: 'x ${projectRoot}' }) });
    expect(await own.launcher.plan(req)).toEqual({ kind: 'spawn', file: 'x', args: ['/proj'] });
  });

  it('opens terminal editors in a terminal panel with shell quoting', async () => {
    const { launcher: l, deps } = launcher({ 'editor.preset': 'terminal', 'editor.command': 'nvim +${line} ${file}' });
    await l.open({ path: '/proj/my file.ts', line: 3 });
    expect(deps.openInTerminal).toHaveBeenCalledWith({
      kind: 'terminal',
      projectId: 'p',
      cwd: '/proj',
      command: "nvim +3 '/proj/my file.ts'",
    });
  });

  it('runs .cmd launchers through cmd.exe on Windows', async () => {
    const { launcher: l, deps } = launcher(
      { 'editor.preset': 'vscode' },
      { platform: 'win32', which: (n) => Promise.resolve(n === 'code' ? 'C:\\VS Code\\bin\\code.cmd' : null) },
    );
    await l.open({ path: 'C:\\p\\a & b.ts', line: 2, column: 1 });
    expect(deps.spawn).toHaveBeenCalledWith(
      'cmd.exe',
      ['/d', '/s', '/c', '"C:\\VS^ Code\\bin\\code.cmd ^"--goto^" ^"C:\\p\\a^ ^&^ b.ts:2:1^""'],
      { verbatim: true },
    );
  });

  it('opens project files in the built-in editor with the oxytocin preset', async () => {
    const { launcher: l, deps } = launcher({ 'editor.preset': 'oxytocin' });
    await l.open({ path: '/proj/src/a.ts', line: 4 });
    expect(deps.openBuiltin).toHaveBeenCalledWith({ projectId: 'p', path: 'src/a.ts', line: 4 });
    // Outside every project: the system default application.
    const outside = launcher({ 'editor.preset': 'oxytocin' }, { projectFor: () => undefined });
    expect(await outside.launcher.plan({ path: '/tmp/x.txt' })).toEqual({ kind: 'system', path: '/tmp/x.txt' });
  });

  it('computes paths relative to a project folder', () => {
    expect(relativeTo('/proj', '/proj/src/a.ts', false)).toBe('src/a.ts');
    expect(relativeTo('C:\\Proj\\', 'c:\\proj\\src\\a.ts', true)).toBe('src/a.ts');
    expect(relativeTo('/proj', '/project/a.ts', false)).toBeNull();
    expect(relativeTo('/proj', '/proj', false)).toBeNull();
  });

  it('refuses missing files', async () => {
    const { launcher: l } = launcher({}, { isFile: () => Promise.resolve(false) });
    await expect(l.open(req)).rejects.toThrow(/File not found/);
  });
});
