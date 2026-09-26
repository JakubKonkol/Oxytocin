import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { launchApp, repoRoot } from './helpers/launch';

export const fixturePlugin = (name: string) => join(repoRoot, 'tests/fixtures/plugins', name);

/** A userData folder whose settings load the given fixture plugins in developer mode. */
export async function userDataWithPlugins(names: string[], extra: Record<string, unknown> = {}): Promise<string> {
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({ 'plugins.developerMode': true, 'plugins.devPaths': names.map(fixturePlugin), ...extra }),
  );
  return userData;
}

interface Descriptor {
  id: string;
  state: string;
  source: string;
  errors?: string[];
}

test('plugins are discovered with states and contributions', async () => {
  const userData = await userDataWithPlugins(['echo', 'broken']);
  const { app, win } = await launchApp({ userData, project: null });
  try {
    const list = (await win.evaluate(() => window.oxy.invoke('plugins:list'))) as Descriptor[];
    expect(list.find((p) => p.id === 'test.echo')).toMatchObject({
      state: expect.stringMatching(/enabled|active/),
      source: 'dev',
    });
    const broken = list.find((p) => p.state === 'invalid')!;
    expect(broken.errors?.join()).toMatch(/id/);
    const contributions = (await win.evaluate(() => window.oxy.invoke('plugins:contributions'))) as {
      commands: { id: string; pluginId: string }[];
    };
    expect(contributions.commands).toContainEqual(expect.objectContaining({ id: 'echo.hello', pluginId: 'test.echo' }));

    await win.evaluate(() => window.oxy.invoke('plugins:setEnabled', { id: 'test.echo', enabled: false }));
    const after = (await win.evaluate(() => window.oxy.invoke('plugins:list'))) as Descriptor[];
    expect(after.find((p) => p.id === 'test.echo')?.state).toBe('disabled');
    expect(
      ((await win.evaluate(() => window.oxy.invoke('plugins:contributions'))) as { commands: unknown[] }).commands,
    ).toEqual([]);
  } finally {
    await app.close();
  }
});

const invoke = (win: Page, channel: string, payload?: unknown) =>
  win.evaluate(([c, p]) => window.oxy.invoke(c as never, p as never), [channel, payload] as const);

test('plugin backends run in the Plugin Host: commands, crash isolation and hang recovery', async () => {
  test.setTimeout(90_000);
  const userData = await userDataWithPlugins(['echo', 'crash-on-activate', 'hang'], { 'echo.greeting': 'Hey' });
  const { app, win } = await launchApp({ userData, project: await mkdtemp(join(tmpdir(), 'oxy-e2e-project-')) });
  try {
    const state = async (id: string) =>
      ((await invoke(win, 'plugins:list')) as Descriptor[]).find((p) => p.id === id)?.state;
    await expect.poll(() => state('test.echo'), { timeout: 15_000 }).toBe('active');
    await expect.poll(() => state('test.crash')).toBe('failed');
    expect(await invoke(win, 'plugins:executeCommand', { id: 'echo.hello', args: ['x'] })).toEqual({
      echo: ['x'],
      greeting: 'Hey',
    });
    const projects = (await invoke(win, 'plugins:executeCommand', { id: 'echo.projects' })) as { name: string }[];
    expect(projects).toHaveLength(1);
    await expect(invoke(win, 'plugins:executeCommand', { id: 'echo.git' })).rejects.toThrow(/permission/);
    const logs = (await invoke(win, 'plugins:logs', { id: 'test.echo' })) as { message: string }[];
    expect(logs.map((l) => l.message)).toContain('echo activated');

    // A plugin blocking the event loop: the host stops answering pings and is restarted.
    void invoke(win, 'plugins:executeCommand', { id: 'hang.forever' }).catch(() => undefined);
    const hostState = async () =>
      ((await invoke(win, 'app:getHostStatus')) as { name: string; state: string; restarts: number }[]).find((h) =>
        h.name.includes('Plugin'),
      );
    await expect.poll(async () => (await hostState())?.restarts, { timeout: 40_000, intervals: [1000] }).toBe(1);
    await expect.poll(async () => (await hostState())?.state, { timeout: 15_000 }).toBe('running');
    // Other plugins come back.
    await expect.poll(() => state('test.echo'), { timeout: 15_000 }).toBe('active');
    expect(await invoke(win, 'plugins:executeCommand', { id: 'echo.hello', args: [] })).toMatchObject({ echo: [] });
  } finally {
    await app.close();
  }
});
