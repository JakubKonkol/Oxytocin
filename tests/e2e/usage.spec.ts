import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Frame, type Page, test } from '@playwright/test';
import { launchApp, repoRoot } from './helpers/launch';
import { waitForTerminal } from './helpers/terminal';

interface Expected {
  sources: Record<string, { costUsdAuto: number }>;
}

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else out.push(p);
  }
  return out;
}

/** Copies the usage fixtures and maps every timestamp linearly into the last two hours of today (order kept). */
async function prepareFixtures(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oxy-e2e-usage-'));
  for (const s of ['claude', 'codex', 'gemini'])
    await cp(join(repoRoot, 'tests/fixtures/usage', s), join(root, s), { recursive: true });
  const all = await files(root);
  const stamps = (await Promise.all(all.map(async (f) => (await readFile(f, 'utf8')).match(ISO) ?? [])))
    .flat()
    .map((t) => Date.parse(t));
  const min = Math.min(...stamps);
  const max = Math.max(...stamps);
  const now = Date.now();
  const dayStart = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const to = now - 60_000;
  const from = Math.max(dayStart + 60_000, to - 2 * 60 * 60_000);
  const map = (t: number) => new Date(from + ((t - min) / (max - min)) * (to - from)).toISOString();
  for (const f of all) {
    const text = await readFile(f, 'utf8');
    await writeFile(
      f,
      text.replace(ISO, (m) => map(Date.parse(m))),
    );
  }
  await mkdir(join(root, 'home'), { recursive: true });
  return root;
}

async function frameOf(win: Page, entry: string): Promise<Frame> {
  let frame: Frame | undefined;
  await expect
    .poll(
      () =>
        (frame = win
          .frames()
          .find((f) => f.url().startsWith(`oxy-plugin://oxytocin.usage-monitor/dist/views/${entry}`))),
      {
        timeout: 15_000,
      },
    )
    .toBeTruthy();
  return frame!;
}

test('Usage Monitor: today from fixtures, live update, dashboard and budget notification', async () => {
  test.setTimeout(90_000);
  const expected = JSON.parse(await readFile(join(repoRoot, 'tests/fixtures/usage/expected.json'), 'utf8')) as Expected;
  const total = Object.values(expected.sources).reduce((sum, s) => sum + s.costUsdAuto, 0);
  const root = await prepareFixtures();
  const home = join(root, 'home');
  // Prices from the built-in snapshot only (expected.json was computed with it; no network in tests).
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ 'usage.pricing.autoUpdate': false }));
  const { app, win } = await launchApp({
    userData,
    project: await mkdtemp(join(tmpdir(), 'oxy-e2e-project-')),
    env: {
      CLAUDE_CONFIG_DIR: join(root, 'claude/home'),
      CODEX_HOME: join(root, 'codex/home'),
      GEMINI_CLI_HOME: join(root, 'gemini/home'),
      HOME: home,
      USERPROFILE: home,
    },
  });
  try {
    await waitForTerminal(win);
    await expect(win.getByTestId('section-header-plugin:oxytocin.usage-monitor:usage.sidebar')).toContainText('USAGE');
    const sidebar = await frameOf(win, 'sidebar.html');
    const today = sidebar.getByTestId('usage-today');
    await expect(today).toHaveText(`$${total.toFixed(2)}`, { timeout: 20_000 });
    await expect(win.getByTestId('status-item-usage.today')).toContainText(`$${total.toFixed(2)}`);
    await expect(sidebar.getByTestId('usage-session').first()).toBeVisible();

    // The fixture's last Claude line is unterminated: completing it adds 999 opus-5-5 output tokens ($0.01998).
    const edge = join(root, 'claude/home/projects/-fixture-proj/edge-0001.jsonl');
    expect((await stat(edge)).size).toBeGreaterThan(0);
    const start = Date.now();
    await appendFile(edge, '\n');
    const next = total + 999 * 0.00002;
    await expect(today).toHaveText(`$${next.toFixed(2)}`, { timeout: 5_000 });
    const latency = Date.now() - start;
    console.log(`usage sidebar updated ${latency} ms after the append`);
    expect(latency).toBeLessThan(2_000);

    // Dashboard from the status bar item.
    await win.getByTestId('status-item-usage.today').click();
    const dashboard = await frameOf(win, 'dashboard.html');
    await expect(dashboard.getByTestId('usage-kpi-today')).toContainText(`$${next.toFixed(2)}`);
    await expect(dashboard.getByTestId('usage-chart')).toBeVisible();

    // A daily budget already 85 % used → the 80 % notification.
    await dashboard.getByRole('tab', { name: 'Budgets' }).click();
    const form = dashboard.getByTestId('usage-budgets');
    await form.getByLabel('Name', { exact: true }).fill('Daily');
    await form.getByLabel('Amount', { exact: true }).fill((next / 0.85).toFixed(2));
    await form.getByRole('button', { name: 'Add budget' }).click();
    await expect(form.getByTestId('usage-budget-row')).toContainText('Daily');
    await expect(win.locator('[data-sonner-toast]').filter({ hasText: 'Budget "Daily": 80% reached' })).toBeVisible({
      timeout: 10_000,
    });
    // The bar shows the most relevant limit (a live Codex session's real limit wins); the tooltip lists all.
    await expect(sidebar.getByTestId('usage-limit')).toHaveAttribute('title', /of daily budget/);

    // Other tabs render.
    await dashboard.getByRole('tab', { name: 'Sessions' }).click();
    await expect(dashboard.getByTestId('usage-session-row').first()).toBeVisible();
    await dashboard.getByRole('tab', { name: 'Pricing' }).click();
    await expect(dashboard.getByTestId('usage-unknown-models')).toContainText('claude-mystery-9');
    await dashboard.getByRole('tab', { name: 'Sources' }).click();
    await expect(dashboard.getByTestId('usage-sources')).toContainText('Claude Code logs');
  } finally {
    await app.close();
  }
});
