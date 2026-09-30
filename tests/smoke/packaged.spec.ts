import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { git } from '../e2e/helpers/git';
import { launchPackaged } from './launch-packaged';
import { nodeCmd, run, waitForTerminal } from '../e2e/helpers/terminal';

/**
 * Release checklist: the packaged app starts, opens a terminal, shows
 * git changes and runs its built-in plugins (loaded from resources/plugins with verified checksums). The release
 * binary has its Electron fuses flipped (no ELECTRON_RUN_AS_NODE, no --inspect, asar only).
 */
test('packaged app: start, terminal, git changes and built-in plugins', async () => {
  const executable = process.env['OXYTOCIN_EXECUTABLE'];
  test.skip(!executable, 'OXYTOCIN_EXECUTABLE is not set');
  const repo = await mkdtemp(join(tmpdir(), 'oxy-smoke-repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  await writeFile(join(repo, 'README.md'), '# Smoke\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  const { win, close } = await launchPackaged(executable!, repo);
  try {
    await expect(win.getByTestId('app-ready')).toBeVisible({ timeout: 30_000 });
    await waitForTerminal(win);
    await run(win, nodeCmd("require('fs').writeFileSync('smoke.txt', 'ok')"));
    await expect(win.getByTestId('changes-section').locator('[data-path="smoke.txt"]')).toBeVisible();

    const plugins = (await win.evaluate(() => window.oxy.invoke('plugins:list'))) as {
      id: string;
      source: string;
      state: string;
      errors?: string[];
    }[];
    for (const id of [
      'oxytocin.markdown-preview',
      'oxytocin.usage-monitor',
      'oxytocin.claude-code-bridge',
      'oxytocin.json-formatter',
      'oxytocin.project-runner',
    ]) {
      const p = plugins.find((x) => x.id === id);
      expect(p, id).toMatchObject({ source: 'builtin' });
      expect(['enabled', 'active'], `${id}: ${(p?.errors ?? []).join('; ')}`).toContain(p!.state);
    }
    await expect(win.getByTestId('status-item-usage.today')).toBeVisible();

    // Every database driver loads from the package (they are bundled into out/main; a missing module shows here):
    // SQLite answers, the others fail on the closed port, not with a load error.
    await writeFile(join(repo, 'smoke.db'), '');
    const projectId = ((await win.evaluate(() => window.oxy.invoke('projects:getActive'))) as { id: string }).id;
    for (const engine of ['sqlite', 'postgresql', 'mysql', 'sqlserver', 'mongodb', 'redis', 'clickhouse', 'oracle']) {
      const resource =
        engine === 'sqlite'
          ? { id: 'smoke', name: 'smoke', engine, connection: { kind: 'file', path: 'smoke.db' } }
          : {
              id: 'smoke',
              name: 'smoke',
              engine,
              connection: { kind: 'fields', host: '127.0.0.1', port: 1, options: {} },
              access: { timeoutMs: 5000 },
            };
      const result = (await win.evaluate(
        ([id, r]) => window.oxy.invoke('resources:test', { projectId: id, kind: 'database', resource: r }),
        [projectId, resource] as const,
      )) as { ok: boolean; error?: { kind: string; message: string } };
      if (engine === 'sqlite') expect(result, engine).toMatchObject({ ok: true });
      else {
        expect(result.error?.message ?? '', engine).not.toMatch(/Cannot find module|MODULE_NOT_FOUND/);
        expect(result.ok, engine).toBe(false);
      }
    }

    // LICENSE and THIRD_PARTY_NOTICES.md ship in resources/.
    await win.getByTestId('app-menu').click();
    await win.getByRole('menuitem', { name: 'Third-Party Notices' }).click();
    await expect(win.getByTestId('legal-notices')).toContainText('## react');
  } finally {
    await close();
  }
});
