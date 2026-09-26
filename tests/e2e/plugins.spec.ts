import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
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
    expect(list.find((p) => p.id === 'test.echo')).toMatchObject({ state: 'enabled', source: 'dev' });
    const broken = list.find((p) => p.state === 'invalid')!;
    expect(broken.errors?.join()).toMatch(/id/);
    const contributions = (await win.evaluate(() => window.oxy.invoke('plugins:contributions'))) as {
      commands: { id: string; pluginId: string }[];
    };
    expect(contributions.commands).toEqual([expect.objectContaining({ id: 'echo.hello', pluginId: 'test.echo' })]);

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
