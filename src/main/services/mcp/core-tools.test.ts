import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { McpToolInfo } from '@shared/domain/mcp';
import type { TerminalInfo } from '@shared/domain/terminal';
import type { ResolvedCaller } from './caller-context';
import { buildCoreTools, type CoreToolsDeps } from './core-tools';

const root = join('/', 'work', 'shop');
const terminal = (over: Partial<TerminalInfo>): TerminalInfo => ({
  id: 't-1',
  projectId: 'p1',
  profileId: 'bash',
  profileName: 'bash',
  title: 'dev',
  pid: 1,
  cwd: root,
  shellType: 'bash',
  kind: 'shell',
  state: 'running',
  createdAt: 0,
  envStale: false,
  bell: false,
  ...over,
});

function setup(over: Partial<CoreToolsDeps> = {}) {
  const notify = vi.fn();
  const ask = vi.fn(() => Promise.resolve<string | null>('Yes'));
  const openFile = vi.fn(() => Promise.resolve());
  const deps: CoreToolsDeps = {
    tools: () =>
      [
        { name: 'oxy_a', description: 'Does A. More text.', source: { kind: 'core' }, listed: true, policy: 'allow' },
        {
          name: 'run_start',
          description: 'Starts.',
          source: { kind: 'plugin', pluginId: 'x', pluginName: 'Project Runner' },
          listed: true,
          policy: 'ask',
        },
        { name: 'hidden', description: 'x', source: { kind: 'core' }, listed: false, policy: 'allow' },
      ] as McpToolInfo[],
    projects: () => [{ id: 'p1', name: 'Shop', rootPath: root }],
    activeProjectId: () => 'p1',
    branch: () => 'main',
    terminals: () => [
      terminal({ command: { commandLine: 'npm run dev', startedAt: 1 } }),
      terminal({
        id: 't-2',
        title: 'tests',
        lastCommand: { commandLine: 'npm test', exitCode: 1, durationMs: 5, finishedAt: 2 },
      }),
    ],
    terminalText: () => Promise.resolve('line 1\nline 2\nerror at x\n\n'),
    notify,
    ask,
    openFile,
    isFile: (p) => Promise.resolve(p.endsWith('.ts')),
    platform: 'linux',
    ...over,
  };
  const tools = new Map(buildCoreTools(deps).map((t) => [t.definition.name, t]));
  const caller: ResolvedCaller = { context: { projectId: 'p1' }, label: 'Shop' };
  const run = (name: string, args: Record<string, unknown> = {}, sessionId = 's1', c = caller) =>
    Promise.resolve().then(() =>
      tools.get(name)!.run({ args, caller: c, sessionId, signal: new AbortController().signal }),
    );
  return { deps, tools, run, notify, ask, openFile };
}

describe('core tools', () => {
  it('are named oxy_* and read terminal output only after asking', () => {
    const { tools } = setup();
    expect([...tools.keys()].every((n) => n.startsWith('oxy_'))).toBe(true);
    expect(tools.get('oxy_read_terminal_output')!.defaultPolicy).toBe('ask');
  });

  it('lists the current tools grouped by source', async () => {
    const { run } = setup();
    expect(await run('oxy_capabilities')).toBe(
      'Oxytocin\n- oxy_a: Does A.\n\nProject Runner\n- run_start: Starts. (asks the user first)',
    );
  });

  it('lists projects and terminals', async () => {
    const { run } = setup();
    expect(JSON.parse((await run('oxy_list_projects')) as string)).toEqual([
      { id: 'p1', name: 'Shop', root, branch: 'main', active: true },
    ]);
    const listed = JSON.parse((await run('oxy_list_terminals')) as string) as { terminals: unknown[] };
    expect(listed.terminals).toEqual([
      expect.objectContaining({ id: 't-1', title: 'dev', runningCommand: 'npm run dev' }),
      expect.objectContaining({ id: 't-2', lastCommand: { commandLine: 'npm test', exitCode: 1 } }),
    ]);
    await expect(
      run('oxy_list_terminals', {}, 's1', { context: {}, projectError: 'No open project "x".' }),
    ).rejects.toThrow('No open project "x".');
  });

  it('reads the last lines of a terminal by id or title', async () => {
    const { run } = setup();
    expect(await run('oxy_read_terminal_output', { terminal: 'DEV', lines: 2 })).toBe(
      'dev (running, running npm run dev) — last 2 of 3 lines:\nline 2\nerror at x',
    );
    await expect(run('oxy_read_terminal_output', { terminal: 'nope' })).rejects.toThrow(/No terminal "nope"/);
    await expect(run('oxy_read_terminal_output', {})).rejects.toThrow(/Pass `terminal`/);
  });

  it('notifies the user, at most 5 times a minute per session', async () => {
    const { run, notify } = setup({ now: () => 1000 });
    for (let i = 0; i < 5; i++) await run('oxy_notify_user', { message: `m${i}`, level: 'warning' });
    expect(notify).toHaveBeenLastCalledWith({ title: 'Agent · Shop', message: 'm4', level: 'warning' });
    await expect(run('oxy_notify_user', { message: 'again' })).rejects.toThrow(/at most 5 per minute/);
    await expect(run('oxy_notify_user', { message: 'other session' }, 's2')).resolves.toBe('The user was notified.');
  });

  it('asks the user with options or free text', async () => {
    const { run, ask } = setup();
    expect(await run('oxy_ask_user', { question: 'Deploy?', options: ['Yes', 'No'], timeout_seconds: 30 })).toBe(
      'The user answered: Yes',
    );
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'Deploy?', options: ['Yes', 'No'], timeoutMs: 30_000 }),
    );
    await expect(run('oxy_ask_user', { question: 'x', options: ['only'] })).rejects.toThrow(/2–10/);
    ask.mockResolvedValueOnce(null);
    expect(await run('oxy_ask_user', { question: 'Name?' })).toMatch(/did not answer within 300 s/);
  });

  it('opens files inside the project only', async () => {
    const { run, openFile } = setup();
    expect(await run('oxy_open_file', { path: 'src/app.ts', line: 12 })).toBe(
      `Opened ${join('src', 'app.ts')} at line 12 for the user.`,
    );
    expect(openFile).toHaveBeenCalledWith({ projectId: 'p1', path: join(root, 'src', 'app.ts'), line: 12 });
    await expect(run('oxy_open_file', { path: '../other/x.ts' })).rejects.toThrow(/outside the project/);
    await expect(run('oxy_open_file', { path: 'README.md' })).rejects.toThrow(/not a file/);
  });
});
