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

interface ViewReport {
  loadedAt: number;
  parentOxy: string;
  fetch: string;
  init: { viewId: string; kind: string; params: unknown; hasTheme: boolean };
  sum: number;
  failError: string;
  state: { counter: number };
  messages: Record<string, unknown>[];
}

test('plugin views: handshake, messages, requests, isolation and moving without reload', async () => {
  const userData = await userDataWithPlugins(['views']);
  const { app, win } = await launchApp({ userData, project: await mkdtemp(join(tmpdir(), 'oxy-e2e-project-')) });
  try {
    const t = (await import('./helpers/terminal')).oxyTest(win);
    await (await import('./helpers/terminal')).waitForTerminal(win);
    expect(await t.openPluginPanel('views.panel', { answer: 42 })).toBeNull();
    const frame = () => win.frames().find((f) => f.url().startsWith('oxy-plugin://test.views/'));
    await expect.poll(() => !!frame(), { timeout: 10_000 }).toBe(true);
    const report = async () =>
      JSON.parse((await frame()!.evaluate(() => document.body.dataset['report'])) ?? '{}') as Partial<ViewReport>;
    await expect
      .poll(async () => (await report()).messages?.length ?? 0, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(2);
    const r = await report();
    expect(r.parentOxy).not.toBe('object');
    expect(r.fetch).toMatch(/^blocked/);
    expect(r.init).toMatchObject({ kind: 'panel', params: { answer: 42 }, hasTheme: true });
    expect(r.sum).toBe(5);
    expect(r.failError).toMatch(/intentional failure/);
    expect(r.state).toEqual({ counter: 1 });
    expect(r.messages).toContainEqual(expect.objectContaining({ kind: 'panel', params: { answer: 42 } }));
    expect(r.messages).toContainEqual(expect.objectContaining({ echo: { ping: 1 } }));
    await expect(win.getByText('Backend title panel')).toBeVisible();

    // Move the panel into a new group: the iframe keeps running (same load time) and still talks to the backend.
    const loadedAt = r.loadedAt;
    await win.keyboard.press('Alt+Shift+Equal');
    await expect.poll(async () => (await t.workspace())?.groups).toBe(2);
    const ws = (await t.workspace())!;
    const plugin = ws.panels.find((p) => p.id.startsWith('plg-'))!;
    const other = ws.panels.find((p) => p.group !== plugin.group)!;
    expect(await t.movePanel(plugin.id, other.id)).toBe(true);
    await frame()!.evaluate(() =>
      (window as unknown as { oxyView: { postMessage(m: unknown): void } }).oxyView.postMessage({ ping: 2 }),
    );
    await expect.poll(async () => JSON.stringify((await report()).messages)).toContain('"ping":2');
    expect((await report()).loadedAt).toBe(loadedAt);
  } finally {
    await app.close();
  }
});
