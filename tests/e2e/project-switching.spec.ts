import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { withinBudget } from './helpers/perf';
import { activeProjectId, nodeCmd, oxyTest, run, waitForTerminal } from './helpers/terminal';

async function folder(name: string): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), 'oxy-e2e-switch-')), name);
  await mkdir(dir);
  return dir;
}

async function addProject(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => window.oxy.invoke('projects:add', { path: p }), path);
}

const counterScript = "let i = 0; setInterval(() => console.log('tick-' + String(i++).padStart(4, '0')), 100)";

function ticks(text: string): number[] {
  return [...text.matchAll(/tick-(\d{4})/g)].map((m) => Number(m[1]));
}

test('switching projects keeps processes running and buffers complete; the title follows', async () => {
  const { app, win } = await launchApp({ project: await folder('alpha') });
  try {
    const t = oxyTest(win);
    const alpha = await waitForTerminal(win);
    await run(win, nodeCmd(counterScript));
    await expect.poll(async () => ticks(await t.text(alpha)).length).toBeGreaterThan(3);
    await expect(win).toHaveTitle(/^alpha — .+ — Oxytocin$/);

    await addProject(win, await folder('beta'));
    await expect(win.getByTestId('projects-item-beta')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => (await t.workspace())?.panels[0]?.terminalId).not.toBe(alpha);
    await expect(win).toHaveTitle(/^beta — /);
    await win.waitForTimeout(1500);

    // Measure mounted switches.
    const times: number[] = [];
    for (let i = 0; i < 6; i++) {
      await win.getByTestId(i % 2 === 0 ? 'projects-item-alpha' : 'projects-item-beta').click();
      await expect
        .poll(() =>
          win.evaluate(() =>
            (window as unknown as { __oxyTest: { lastSwitchMs(): number | null } }).__oxyTest.lastSwitchMs(),
          ),
        )
        .not.toBeNull();
      times.push(
        (await win.evaluate(() =>
          (window as unknown as { __oxyTest: { lastSwitchMs(): number | null } }).__oxyTest.lastSwitchMs(),
        ))!,
      );
    }
    await win.getByTestId('projects-item-alpha').click();
    await expect.poll(async () => (await t.workspace())?.panels[0]?.terminalId).toBe(alpha);
    const seen = ticks(await t.text(alpha));
    // No gaps while alpha was hidden.
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBe(seen[i - 1]! + 1);
    expect(seen.length).toBeGreaterThan(20);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(`project switch avg ${avg.toFixed(1)} ms (${times.map((x) => x.toFixed(0)).join(', ')})`);
    await withinBudget('projectSwitchMountedAverage', avg, 150);
  } finally {
    await app.close();
  }
});

test('with keepAliveProjects=1 an evicted workspace is rehydrated with its colours, or empty once its panels were closed', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ 'workspace.keepAliveProjects': 1 }));
  const { app, win } = await launchApp({ userData, project: await folder('one') });
  try {
    const t = oxyTest(win);
    const first = await waitForTerminal(win);
    await run(
      win,
      nodeCmd("console.log(String.fromCharCode(27) + '[32m' + 'GREEN' + 'LINE' + String.fromCharCode(27) + '[0m')"),
    );
    await expect.poll(() => t.color(first, 'GREENLINE')).toMatchObject({ palette: true, fg: 2 });

    await addProject(win, await folder('two'));
    await expect(win.getByTestId('projects-item-two')).toHaveAttribute('aria-selected', 'true');
    await expect(win.getByTestId('mounted-workspace')).toHaveCount(1);
    expect(await t.terminalIds()).not.toContain(first);

    await win.getByTestId('projects-item-one').click();
    await expect.poll(async () => (await t.workspace())?.panels[0]?.terminalId).toBe(first);
    await expect.poll(() => t.color(first, 'GREENLINE')).toMatchObject({ palette: true, fg: 2 });

    // Closing the project's only terminal shows the workspace's choices and turns the project's dot off.
    const one = await activeProjectId(win);
    const dot = win.getByTestId(`status-dot-${one}`);
    await expect(dot).toHaveAttribute('data-state', 'idle');
    const panel = (await t.workspace())!.panels[0]!;
    await win.getByTestId(`tab-${panel.id}`).getByRole('button', { name: 'Close' }).click();
    const oneWorkspace = win.locator(`[data-workspace-id="${one}"]`);
    await expect(oneWorkspace.getByTestId('empty-workspace')).toBeVisible();
    await expect(dot).toHaveCount(0);

    // A background terminal (a Project Runner script) marks the project only while its script runs.
    const marker = join(await mkdtemp(join(tmpdir(), 'oxy-e2e-marker-')), 'done').replace(/\\/g, '/');
    const script = `setInterval(() => { if (require('fs').existsSync('${marker}')) process.exit(0); }, 100)`;
    await win.evaluate(
      ([projectId, initialCommand]) =>
        window.oxy.invoke('terminals:create', { projectId, background: true, initialCommand }),
      [one, nodeCmd(script)] as const,
    );
    await expect(dot).toHaveAttribute('data-state', 'running', { timeout: 20_000 });
    await writeFile(marker, '');
    await expect(dot).toHaveCount(0, { timeout: 20_000 });

    // Opened again after its eviction, the emptied project starts no terminal by itself.
    await win.getByTestId('projects-item-two').click();
    await expect(win.getByTestId('projects-item-two')).toHaveAttribute('aria-selected', 'true');
    await expect(win.locator(`[data-workspace-id="${one}"]`)).toHaveCount(0);
    await win.getByTestId('projects-item-one').click();
    await expect(oneWorkspace.getByTestId('empty-workspace')).toBeVisible();
    // A short pause before asserting that no terminal is started.
    await win.waitForTimeout(1000);
    await expect(oneWorkspace.getByTestId('empty-workspace')).toBeVisible();
    const terminals = (await win.evaluate(() => window.oxy.invoke('terminals:list', {}))) as {
      projectId: string;
      background?: boolean;
    }[];
    expect(terminals.filter((x) => x.projectId === one && !x.background)).toEqual([]);
  } finally {
    await app.close();
  }
});
