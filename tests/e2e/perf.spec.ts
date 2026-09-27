import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, repoRoot } from './helpers/launch';
import { oxyTest, waitForTerminal } from './helpers/terminal';

/** Records a metric in perf-results.json (CI artifact; docs/plan/10-quality-testing-release.md §5). */
async function record(name: string, value: number, unit: string, budget?: number): Promise<void> {
  const file = join(repoRoot, 'perf-results.json');
  let results: Record<string, unknown>;
  try {
    results = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    results = {};
  }
  results[name] = {
    value,
    unit,
    ...(budget !== undefined ? { budget } : {}),
    platform: process.platform,
    at: new Date().toISOString(),
  };
  await writeFile(file, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`perf ${name}: ${value} ${unit}${budget !== undefined ? ` (CI budget ${budget})` : ''}`);
}

test('performance budgets: start-up, mounted project switch and memory of 3 projects × 3 terminals', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), 'oxy-e2e-perf-'));
  const folders = ['alpha', 'beta', 'gamma'].map((n) => join(root, n));
  for (const f of folders) await mkdir(f);
  const { app, win } = await launchApp({ project: folders[0]! });
  try {
    await waitForTerminal(win);
    const startup = await app.evaluate(
      () =>
        (globalThis as unknown as { __oxyMain: { perf(): { firstTerminalOutputMs: number | null } } }).__oxyMain.perf()
          .firstTerminalOutputMs,
    );
    expect(startup).not.toBeNull();
    await record('startToFirstTerminalOutput', startup!, 'ms', 3000);
    expect(startup!).toBeLessThan(3000);

    // Three projects with three terminals each.
    const t = oxyTest(win);
    for (let i = 0; i < folders.length; i++) {
      if (i > 0) {
        await win.evaluate((p) => window.oxy.invoke('projects:add', { path: p }), folders[i]!);
        await expect(win.getByTestId(`projects-item-${['alpha', 'beta', 'gamma'][i]}`)).toHaveAttribute(
          'aria-selected',
          'true',
        );
        await waitForTerminal(win);
      }
      for (let n = 1; n < 3; n++) {
        await win.keyboard.press('Control+Shift+KeyT');
        await expect.poll(async () => (await t.workspace())?.panels.length).toBe(n + 1);
      }
    }
    await win.waitForTimeout(1500);

    // Mounted project switches (renderer mark: activation → workspace painted).
    const times: number[] = [];
    for (let i = 0; i < 9; i++) {
      await win.getByTestId(`projects-item-${['alpha', 'beta', 'gamma'][i % 3]}`).click();
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
    const sorted = [...times].sort((a, b) => a - b);
    const median = Math.round(sorted[Math.floor(sorted.length / 2)]!);
    await record('projectSwitchMountedMedian', median, 'ms', 150);
    expect(median).toBeLessThan(150);

    // Memory of all processes (report only): private memory — resident sizes count shared libraries once per process.
    const metrics = await app.evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().map((m) => ({
        pid: m.pid,
        type: m.type,
        name: m.name ?? m.serviceName ?? '',
        workingSetKb: m.memory.workingSetSize,
        privateKb: m.memory.privateBytes ?? null,
      })),
    );
    let privateMb = 0;
    const breakdown: string[] = [];
    for (const m of metrics) {
      let kb = m.privateKb ?? m.workingSetKb;
      if (process.platform === 'linux') {
        const rollup = await readFile(`/proc/${m.pid}/smaps_rollup`, 'utf8').catch(() => '');
        const field = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(rollup)?.[1] ?? 0);
        if (rollup) kb = field('Private_Clean') + field('Private_Dirty');
      }
      privateMb += kb / 1024;
      breakdown.push(`${m.type}${m.name ? ` (${m.name})` : ''} ${Math.round(kb / 1024)} MB`);
    }
    console.log(`memory by process: ${breakdown.join(', ')}`);
    await record('memory3x3Private', Math.round(privateMb), 'MB', 450);
  } finally {
    await app.close();
  }
});
