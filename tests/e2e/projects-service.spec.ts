import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';

test('a folder passed on the command line is added and activated', async () => {
  const base = await mkdtemp(join(tmpdir(), 'oxy-proj-'));
  const folder = join(base, 'my-api');
  await mkdir(folder);
  const { app, win } = await launchApp({ project: folder });
  try {
    await expect
      .poll(async () =>
        ((await win.evaluate(() => window.oxy.invoke('projects:list'))) as { name: string }[]).map((p) => p.name),
      )
      .toEqual(['my-api']);
    const list = (await win.evaluate(() => window.oxy.invoke('projects:list'))) as { id: string; rootPath: string }[];
    const active = (await win.evaluate(() => window.oxy.invoke('projects:getActive'))) as { id: string | null };
    expect(active.id).toBe(list[0]!.id);

    // Adding the same folder again activates the existing project.
    const again = (await win.evaluate((p) => window.oxy.invoke('projects:add', { path: p }), folder)) as {
      existed: boolean;
    };
    expect(again.existed).toBe(true);
  } finally {
    await app.close();
  }
});
