import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { interrupt, nodeCmd, oxyTest, run, waitForTerminal } from './helpers/terminal';

test('the workspace shows a terminal panel with a card header; long tab titles keep the close button in view', async () => {
  const { app, win } = await launchApp();
  try {
    const first = await waitForTerminal(win);
    const tab = win.locator('[data-testid^="tab-term-"]').first();
    await expect(tab).toBeVisible();
    await expect(tab).toContainText('SHELL');
    await expect(tab.getByRole('img', { name: 'Idle' })).toBeVisible();
    await expect(win.locator('.dv-groupview.dv-active-group')).toHaveCount(1);

    // A single tab spans the header; with a very long title (set by the program) its close button stays in view.
    const t = oxyTest(win);
    await run(
      win,
      nodeCmd(
        "process.stdout.write(String.fromCharCode(27) + ']0;' + 'Long title '.repeat(60) + String.fromCharCode(7)); setInterval(() => {}, 1000)",
      ),
    );
    await expect(tab.getByTestId('tab-title')).toContainText('Long title Long title Long title');
    await expect(tab.getByRole('button', { name: 'Close' })).toBeInViewport({ ratio: 1 });
    await interrupt(win, first);
    const long = (name: string) => `${name} ${'with a very long name '.repeat(3)}`.trim();

    // A second tab in the same group, both with long names: the titles are cut, both close buttons stay in view.
    await win.getByTestId(`terminal-view-${first}`).click();
    await win.keyboard.press('Control+Shift+T');
    await expect.poll(async () => (await t.workspace())?.panels.length).toBe(2);
    for (const [i, p] of (await t.workspace())!.panels.entries())
      await win.evaluate(([id, title]) => window.oxy.invoke('terminals:rename', { id, title }), [
        p.terminalId!,
        long(`Tab ${i + 1}`),
      ] as const);
    const tabs = win.locator('[data-testid^="tab-term-"]');
    await expect(tabs.getByTestId('tab-title').filter({ hasText: long('Tab 2') })).toHaveAttribute(
      'title',
      long('Tab 2'),
    );
    for (const panel of await tabs.all()) {
      const title = panel.getByTestId('tab-title');
      expect(await title.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      await panel.hover();
      await expect(panel.getByRole('button', { name: 'Close' })).toBeInViewport({ ratio: 1 });
    }
    await win.screenshot({ path: test.info().outputPath('long-tab-titles.png') });
    // One click on the inactive tab's close button closes it.
    const inactive = win.locator('[data-testid^="tab-term-"][data-active="false"]');
    await inactive.getByRole('button', { name: 'Close' }).click();
    await expect.poll(async () => (await t.workspace())?.panels.length).toBe(1);
  } finally {
    await app.close();
  }
});
