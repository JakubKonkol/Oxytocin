/**
 * README screenshots of a demo setup (tests/screenshots/demo-data.ts), saved to docs/images/.
 * Run: `npm run build && xvfb-run -a -s "-screen 0 3200x2000x24" npm run screenshots` (Linux) or `npm run screenshots`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Frame, type Page, test } from '@playwright/test';
import { defaultUiState } from '../../src/shared/domain/ui-state';
import { launchApp, repoRoot } from '../e2e/helpers/launch';
import { oxyTest, run, waitForPrompt, waitForTerminal } from '../e2e/helpers/terminal';
import { createDemo } from './demo-data';

const WIDTH = 1440;
const HEIGHT = 900;
const images = join(repoRoot, 'docs/images');

const SCRATCHPAD = `## Today
- [x] Fix rounding of the cart total
- [ ] Move the API client to fetch with retries
- [ ] Tests for useCart
- [ ] Review payments-api webhooks PR

## Prompt draft
Refactor \`src/api/client.ts\` to use the new **withRetry** helper. Keep the public API, add tests.
`;

const ORDER = JSON.stringify({
  order: {
    id: 'ord_7Kx2Qm',
    status: 'paid',
    total: { amount: 12900, currency: 'EUR' },
    items: [
      { sku: 'TSHIRT-M', qty: 2, price: 4500 },
      { sku: 'MUG-01', qty: 1, price: 3900 },
    ],
    customer: { email: 'ada@example.com', country: 'PL' },
    paidAt: '2026-09-28T09:41:07Z',
  },
});

async function frameOf(win: Page, prefix: string): Promise<Frame> {
  let frame: Frame | undefined;
  await expect
    .poll(() => (frame = win.frames().find((f) => f.url().startsWith(prefix) && !f.isDetached())))
    .toBeTruthy();
  return frame!;
}

test('README screenshots', async () => {
  const demo = await createDemo(join(tmpdir(), 'oxytocin-demo'));
  const userData = join(demo.root, 'user-data');
  await mkdir(userData, { recursive: true });
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({
      'usage.pricing.autoUpdate': false,
      'updates.checkAutomatically': false,
      'notifications.os': false,
    }),
  );
  const ui = defaultUiState();
  ui.secondarySidebar = { width: 330, collapsed: false };
  ui.scratchpad.text = SCRATCHPAD;
  const usagePane = 'plugin:oxytocin.usage-monitor:usage.sidebar';
  ui.paneview = {
    order: ['projects', 'changes', usagePane],
    sizes: { projects: 150, changes: 330, [usagePane]: 250 },
    collapsed: [],
    hidden: [],
  };
  await writeFile(join(userData, 'ui-state.json'), JSON.stringify(ui));

  const { app, win } = await launchApp({
    userData,
    project: demo.projects.acmeWeb,
    args: ['--force-device-scale-factor=2'],
    env: {
      HOME: demo.home,
      USERPROFILE: demo.home,
      SHELL: '/bin/bash',
      CLAUDE_CONFIG_DIR: demo.claudeDir,
      CODEX_HOME: join(demo.root, 'codex'),
      GEMINI_CLI_HOME: join(demo.root, 'gemini'),
    },
  });
  try {
    await app.evaluate(
      ({ BrowserWindow }, [w, h]) => {
        const bw = BrowserWindow.getAllWindows()[0]!;
        bw.unmaximize();
        bw.setContentSize(w!, h!);
        bw.center();
      },
      [WIDTH, HEIGHT],
    );
    const agent = await waitForTerminal(win);

    // More projects in the sidebar; acme-web stays active.
    for (const path of [demo.projects.paymentsApi, demo.projects.docsSite])
      await win.evaluate((p) => window.oxy.invoke('projects:add', { path: p }), path);
    const projects = (await win.evaluate(() => window.oxy.invoke('projects:list'))) as {
      id: string;
      rootPath: string;
    }[];
    const acme = projects.find((p) => p.rootPath === demo.projects.acmeWeb)!;
    await win.evaluate((id) => window.oxy.invoke('projects:setActive', { id }), acme.id);
    await expect.poll(() => oxyTest(win).activeTerminalId()).toBe(agent);

    // Claude Code at work in the first terminal.
    await win.locator(`[data-terminal-id="${agent}"] .xterm`).click();
    await waitForPrompt(win, agent);
    await run(win, 'claude');
    await expect.poll(() => oxyTest(win).text(agent)).toContain('Refactoring checkout');
    await expect(win.getByTestId('terminal-kind-badge').first()).toHaveText('AI AGENT', { timeout: 20_000 });
    await expect(win.getByTestId('changes-tree')).toContainText('client.ts');
    const sidebar = await frameOf(win, 'oxy-plugin://oxytocin.usage-monitor/dist/views/sidebar.html');
    await expect(sidebar.getByTestId('usage-today')).toBeVisible({ timeout: 30_000 });
    await win.mouse.move(WIDTH / 2, HEIGHT - 5);
    await win.waitForTimeout(1500);
    await win.screenshot({ path: join(images, 'overview.png') });

    // Usage dashboard (right sidebar closed for room).
    await win.getByTestId('toggle-secondary-sidebar').click();
    await win.getByTestId('status-item-usage.today').click();
    const dashboard = await frameOf(win, 'oxy-plugin://oxytocin.usage-monitor/dist/views/dashboard.html');
    await expect(dashboard.getByTestId('usage-chart')).toBeVisible();
    await win.mouse.move(WIDTH / 2, HEIGHT - 5);
    await win.waitForTimeout(1500);
    await win.screenshot({ path: join(images, 'usage-dashboard.png') });
    await win.keyboard.press('Control+Shift+KeyW');

    // Modular layout: agent | dev server over a JSON Formatter, with the "+" menu open.
    const ws = win.getByTestId(`workspace-${acme.id}`);
    await win.locator(`[data-terminal-id="${agent}"] .xterm`).click();
    await ws.getByRole('button', { name: 'Split right' }).first().click();
    const dev = await waitForTerminal(win, 1);
    await win.locator(`[data-terminal-id="${dev}"] .xterm`).click();
    await waitForPrompt(win, dev);
    await run(win, 'npm run dev');
    await expect.poll(() => oxyTest(win).text(dev)).toContain('hmr update');
    // A terminal below the dev server, replaced by a JSON Formatter from the "+" menu.
    await ws.getByRole('button', { name: 'Split down' }).last().click();
    await waitForTerminal(win, 2);
    await ws.getByTestId('group-add').last().click();
    await win.getByTestId('group-add-menu').getByTestId('add-tool-plugin:json.formatter').click();
    const json = await frameOf(win, 'oxy-plugin://oxytocin.json-formatter/');
    await json.getByTestId('json-input').fill(ORDER);
    await json.getByTestId('json-format').click();
    await expect(json.getByTestId('json-status')).toContainText('Valid JSON');
    await ws.locator('.dv-groupview').last().locator('.dv-tab').first().click({ button: 'right' });
    await win.getByText('Close', { exact: true }).click();
    await expect.poll(async () => (await oxyTest(win).workspace())?.groups).toBe(3);
    await win.waitForTimeout(800);
    await ws.getByTestId('group-add').last().click();
    await expect(win.getByTestId('group-add-menu')).toBeVisible();
    await win.getByTestId('group-add-menu').getByTestId('add-tool-plugin:json.formatter').hover();
    await win.waitForTimeout(800);
    await win.screenshot({ path: join(images, 'modular-workspace.png') });
    await win.keyboard.press('Escape');
  } finally {
    await app.close();
  }
});
