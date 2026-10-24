import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Frame, type Page, test } from '@playwright/test';
import { launchApp, repoRoot } from './helpers/launch';
import { connect, freePort } from './helpers/mcp';
import { withinBudget } from './helpers/perf';
import { activeProjectId, oxyTest, run, waitForTerminal } from './helpers/terminal';

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
    await expect(today).toHaveText(`$${next.toFixed(2)}`, { timeout: 10_000 });
    const latency = Date.now() - start;
    console.log(`usage sidebar updated ${latency} ms after the append`);
    await withinBudget('usageSidebarUpdate', latency, 2_000);

    // Dashboard from the status bar item.
    await win.getByTestId('status-item-usage.today').click();
    const dashboard = await frameOf(win, 'dashboard.html');
    await dashboard.getByTestId('usage-refresh').click();
    await expect(dashboard.getByTestId('usage-refresh')).toBeEnabled({ timeout: 20_000 });
    await expect(dashboard.getByTestId('usage-kpi-today')).toContainText(`$${next.toFixed(2)}`);
    await expect(dashboard.getByTestId('usage-chart')).toBeVisible();

    // The sidebar card can show only the usage: hide its active sessions, then bring them back (before the budget
    // below raises a toast over the window).
    await dashboard.getByRole('tab', { name: 'Settings' }).click();
    const toggle = async (id: string, on: boolean) => {
      const box = dashboard.getByTestId(id);
      await expect(box).toBeChecked({ checked: !on });
      await box.click();
      await expect(box).toBeChecked({ checked: on });
    };
    await toggle('usage-sidebar-showSessions', false);
    await expect(sidebar.getByTestId('usage-sessions')).toHaveCount(0);
    await expect(sidebar.getByTestId('usage-today')).toBeVisible();
    await toggle('usage-sidebar-showToday', false);
    await expect(sidebar.getByTestId('usage-today')).toHaveCount(0);
    await toggle('usage-sidebar-showToday', true);
    await toggle('usage-sidebar-showSessions', true);
    await expect(sidebar.getByTestId('usage-session').first()).toBeVisible();

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
    await dashboard.getByRole('tab', { name: 'Settings' }).click();
    await expect(dashboard.getByTestId('usage-unknown-models')).toContainText('claude-mystery-9');
    await dashboard.getByRole('tab', { name: 'Sources' }).click();
    await expect(dashboard.getByTestId('usage-sources')).toContainText('Claude Code logs');
  } finally {
    await app.close();
  }
});

test('Usage Monitor: Claude subscription limits through the Claude Code status line', async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), 'oxy-e2e-limits-'));
  const claudeDir = join(root, 'claude');
  await mkdir(claudeDir, { recursive: true });
  const settingsFile = join(claudeDir, 'settings.json');
  const original = { type: 'command', command: 'echo mine', padding: 1 };
  await writeFile(settingsFile, JSON.stringify({ model: 'opus', statusLine: original }));
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({ 'usage.pricing.autoUpdate': false, 'usage.billing.claudeCode': 'subscription' }),
  );
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  const { app, win } = await launchApp({
    userData,
    project: await mkdtemp(join(tmpdir(), 'oxy-e2e-project-')),
    env: {
      CLAUDE_CONFIG_DIR: claudeDir,
      CODEX_HOME: join(root, 'codex'),
      GEMINI_CLI_HOME: join(root, 'gemini'),
      HOME: home,
      USERPROFILE: home,
    },
  });
  const statusLine = async () =>
    (JSON.parse(await readFile(settingsFile, 'utf8')) as { statusLine?: { command?: string } }).statusLine;
  try {
    await waitForTerminal(win);
    const sidebar = await frameOf(win, 'sidebar.html');
    // Subscription billing: no costs in the sidebar, a hint to turn on the plan limits instead.
    await expect(sidebar.getByTestId('usage-subscription-hint')).toBeVisible({ timeout: 20_000 });
    await expect(sidebar.getByTestId('usage-today')).toHaveCount(0);
    await expect(win.getByTestId('status-item-usage.today')).toContainText('0 tokens');
    // The gear in the Usage card opens the dashboard's Settings tab.
    await sidebar.getByTestId('usage-settings').click();
    const dashboard = await frameOf(win, 'dashboard.html');
    await expect(dashboard.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
    const section = dashboard.getByTestId('usage-claude-limits');
    await section.getByLabel('Show Claude subscription limits').check();

    // Our script becomes the status line; the previous command is kept for it to run.
    await expect.poll(async () => (await statusLine())?.command ?? '').toContain('oxytocin-statusline');
    expect(await statusLine()).toMatchObject({ type: 'command', padding: 1 });
    const dir = join(claudeDir, 'oxytocin-statusline');
    expect(await readFile(join(dir, 'original-command'), 'utf8')).toBe('echo mine');
    await expect(section.getByTestId('usage-claude-limits-state')).toContainText('no reading yet');

    // What the script saves when Claude Code reports the limits.
    const now = Math.floor(Date.now() / 1000);
    await writeFile(
      join(dir, 'usage.json'),
      JSON.stringify({
        session_id: 'e2e',
        rate_limits: {
          five_hour: { used_percentage: 23.5, resets_at: now + 2 * 3600 },
          seven_day: { used_percentage: 41.2, resets_at: now + 3 * 86400 },
        },
      }),
    );
    const bars = sidebar.getByTestId('usage-subscription-limit');
    await expect(bars).toHaveCount(2, { timeout: 10_000 });
    const mainLimits = sidebar.locator('[data-testid="usage-account-limits"][data-account="main"]');
    await expect(mainLimits).toContainText('Claude (main)');
    await expect(bars.nth(0)).toContainText('24% of 5h limit · resets in');
    await expect(bars.nth(0)).toContainText('· as of');
    await expect(bars.nth(1)).toContainText('41% of weekly limit');
    await expect(win.getByTestId('status-item-usage.today')).toContainText('5h 24% · week 41%');
    await expect(sidebar.getByTestId('usage-subscription-hint')).toHaveCount(0);
    await expect(sidebar.getByTestId('usage-plan-heading')).toHaveText('PLAN LIMITS');
    await expect(section.getByTestId('usage-claude-limits-state')).toContainText('last reading');

    // External settings changes can disconnect limit updates. Expose and repair the source instead of repainting stale readings.
    await writeFile(settingsFile, JSON.stringify({ model: 'opus' }));
    await dashboard.getByTestId('usage-refresh').click();
    await expect(section.getByTestId('usage-repair-limits')).toBeVisible();
    await expect(sidebar.getByTestId('usage-limits-disconnected')).toBeVisible();
    await section.getByTestId('usage-repair-limits').click();
    await expect.poll(async () => (await statusLine())?.command ?? '').toContain('oxytocin-statusline');
    expect(await readFile(join(dir, 'original-command'), 'utf8')).toBe('echo mine');

    // An added account (Settings → AI Agents) shares the main settings, so the same script saves its readings in
    // a file of its own; the transcript tells whose they are.
    const state = (await win.evaluate(() =>
      window.oxy.invoke('aiAgents:addAccount', { agent: 'claude', name: 'Work', mode: 'shared' }),
    )) as { accounts: { id: string; home: string }[] };
    const work = state.accounts[0]!;
    await writeFile(
      join(dir, 'usage-work.json'),
      JSON.stringify({
        transcript_path: join(work.home, 'projects', '-p', 'e2e.jsonl'),
        rate_limits: { five_hour: { used_percentage: 75, resets_at: now + 3600 } },
      }),
    );
    const workLimits = sidebar.locator(`[data-testid="usage-account-limits"][data-account="${work.id}"]`);
    await expect(workLimits).toContainText('Claude (Work)', { timeout: 10_000 });
    await expect(workLimits).toContainText('75% of 5h limit');
    // The main account keeps its own numbers.
    await expect(mainLimits).toContainText('24% of 5h limit');

    // Turning it off restores the previous status line.
    await section.getByLabel('Show Claude subscription limits').uncheck();
    await expect
      .poll(() => readFile(settingsFile, 'utf8').then((t) => JSON.parse(t) as unknown))
      .toEqual({
        model: 'opus',
        statusLine: original,
      });
  } finally {
    await app.close();
  }
});

test("Usage Monitor: the Code Map calls of an agent's MCP session show next to its usage session", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), 'oxy-e2e-usage-map-'));
  const claudeDir = join(root, 'claude');
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  const project = await mkdtemp(join(tmpdir(), 'oxy-e2e-project-'));
  await writeFile(join(project, 'api.ts'), 'export function beforeEdit() {}\n');
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ 'usage.pricing.autoUpdate': false }));
  const { app, win } = await launchApp({
    userData,
    project,
    env: {
      CLAUDE_CONFIG_DIR: claudeDir,
      CODEX_HOME: join(root, 'codex'),
      GEMINI_CLI_HOME: join(root, 'gemini'),
      HOME: home,
      USERPROFILE: home,
    },
  });
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const terminalId = await waitForTerminal(win);
    // An agent in the terminal: the fake Claude Code registers its session id with Oxytocin.
    await run(win, `node "${join(repoRoot, 'tests/fixtures/agents/node_modules/@anthropic-ai/claude-code/cli.js')}"`);
    await expect.poll(() => oxyTest(win).text(terminalId)).toContain('fake-claude>');
    let sessionId = '';
    await expect
      .poll(async () => {
        const agents = (await win.evaluate(() => window.oxy.invoke('agents:list'))) as {
          terminalId: string;
          sessionId?: string;
        }[];
        sessionId = agents.find((a) => a.terminalId === terminalId)?.sessionId ?? '';
        return sessionId;
      })
      .toMatch(/^fake-/);

    const projectId = await activeProjectId(win);
    const port = await freePort();
    await win.evaluate((port) => window.oxy.invoke('settings:update', { 'mcp.enabled': true, 'mcp.port': port }), port);
    await win.locator(`[data-project-id="${projectId}"]`).click({ button: 'right' });
    await win.getByTestId('project-menu-settings').click();
    await win.getByTestId('project-settings-tab-code-map').click();
    await win.getByTestId('code-map-enabled').click();
    await win
      .getByRole('alertdialog', { name: 'Enable Code Map?' })
      .getByRole('button', { name: 'Enable Code Map', exact: true })
      .click();
    await expect(win.getByTestId('code-map-state')).toHaveText('Ready', { timeout: 20_000 });
    await win.getByTestId('project-settings-save').click();
    await expect(win.getByTestId('project-settings')).toHaveCount(0);

    // The agent's MCP client names its terminal in the header, like the registered `claude mcp` entry does.
    const token = (JSON.parse(await readFile(join(userData, 'mcp.json'), 'utf8')) as { token: string }).token;
    client = await connect(port, token, { 'X-Oxytocin-Terminal': terminalId });
    const startedAt = Date.now() - 5000;
    for (const query of ['beforeEdit', 'beforeEdit']) {
      const found = await client.call('oxy_find_code', { query, cwd: project });
      expect(found.result?.content?.[0]?.text).toContain('beforeEdit');
    }
    await client.call('oxy_file_outline', { path: 'missing.ts', cwd: project });

    // Its usage: two requests around the calls (the transcript Claude Code writes).
    const line = (n: number, at: number) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(at).toISOString(),
        sessionId,
        uuid: `00000000-0000-4000-8000-00000000000${n}`,
        cwd: project,
        message: {
          id: `msg_map_${n}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0 },
        },
      });
    await mkdir(join(claudeDir, 'projects/-map'), { recursive: true });
    await writeFile(
      join(claudeDir, 'projects/-map', `${sessionId}.jsonl`),
      `${line(1, startedAt)}\n${line(2, Date.now() + 1000)}\n`,
    );

    await win.getByTestId('status-item-usage.today').click();
    const dashboard = await frameOf(win, 'dashboard.html');
    await dashboard.getByRole('tab', { name: 'Sessions' }).click();
    const cell = dashboard.getByTestId('usage-session-codemap');
    await expect(async () => {
      await dashboard.getByTestId('usage-refresh').click();
      await expect(cell).toHaveText(/^3 · \d+$/, { timeout: 3000 });
    }).toPass({ timeout: 30_000 });
    // Counts only; the tooltip tells what they are, including the answer that was not OK (NOT_FOUND).
    await expect(cell).toHaveAttribute(
      'title',
      /Code Map calls: 3, \d+ characters answered, 0 stale, 1 not OK, 0 failed/,
    );
    await expect(cell).not.toContainText('beforeEdit');
    await expect(cell).not.toHaveAttribute('title', /beforeEdit|api\.ts|missing/);
  } finally {
    client?.close();
    await app.close();
  }
});
