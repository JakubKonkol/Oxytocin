import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { git } from '../e2e/helpers/git';
import { launchApp } from '../e2e/helpers/launch';
import { nodeCmd, run, waitForTerminal } from '../e2e/helpers/terminal';

/**
 * Release checklist (docs/plan/10-quality-testing-release.md §11): the packaged app starts, opens a terminal, shows
 * git changes and runs its built-in plugins (loaded from resources/plugins with verified checksums).
 */
test('packaged app: start, terminal, git changes and built-in plugins', async () => {
  test.skip(!process.env['OXYTOCIN_EXECUTABLE'], 'OXYTOCIN_EXECUTABLE is not set');
  const repo = await mkdtemp(join(tmpdir(), 'oxy-smoke-repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  await writeFile(join(repo, 'README.md'), '# Smoke\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  const { app, win } = await launchApp({ project: repo });
  try {
    expect(await app.evaluate(({ app: a }) => a.isPackaged)).toBe(true);
    await waitForTerminal(win);
    await run(win, nodeCmd("require('fs').writeFileSync('smoke.txt', 'ok')"));
    await expect(win.getByTestId('changes-section').locator('[data-path="smoke.txt"]')).toBeVisible();

    const plugins = (await win.evaluate(() => window.oxy.invoke('plugins:list'))) as {
      id: string;
      source: string;
      state: string;
      errors?: string[];
    }[];
    for (const id of ['oxytocin.markdown-preview', 'oxytocin.usage-monitor']) {
      const p = plugins.find((x) => x.id === id);
      expect(p, id).toMatchObject({ source: 'builtin' });
      expect(['enabled', 'active'], `${id}: ${(p?.errors ?? []).join('; ')}`).toContain(p!.state);
    }
    await expect(win.getByTestId('status-item-usage.today')).toBeVisible();

    // LICENSE and THIRD_PARTY_NOTICES.md ship in resources/.
    await win.getByTestId('app-menu').click();
    await win.getByRole('menuitem', { name: 'Third-Party Notices' }).click();
    await expect(win.getByTestId('legal-notices')).toContainText('## react');
  } finally {
    await app.close();
  }
});
