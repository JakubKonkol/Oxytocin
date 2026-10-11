import { expect, type Page, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { waitForTerminal } from './helpers/terminal';

const USAGE = 'plugin:oxytocin.usage-monitor:usage.sidebar';

const leftPanes = (win: Page) =>
  win
    .getByTestId('sidebar')
    .locator('[data-testid^="section-header-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('section-header-', '')));

const paneview = (win: Page) =>
  win.evaluate(() => window.oxy.invoke('ui:getState')) as Promise<{
    paneview: { hidden: string[]; sizes: Record<string, number> };
    primaryTools: { kind: string }[];
  }>;

async function closeSection(win: Page, id: string): Promise<void> {
  await win.getByTestId(`section-header-${id}`).hover();
  await win.getByTestId(`close-section-${id}`).click();
  await expect(win.getByTestId(`section-header-${id}`)).toHaveCount(0);
}

test('left sidebar sections close with "×", come back from "+" and stay closed after a restart', async () => {
  test.setTimeout(90_000);
  const first = await launchApp();
  const { userData } = first;
  try {
    const { win } = first;
    await waitForTerminal(win);
    await expect(win.getByTestId(`section-header-${USAGE}`)).toBeVisible();
    await expect.poll(() => leftPanes(win)).toEqual(['projects', 'changes', 'files', USAGE]);

    // "×" closes FILES; "+" of CHANGES lists it and adds it back right below.
    await closeSection(win, 'files');
    await expect.poll(async () => (await paneview(win)).paneview.hidden).toEqual(['files']);
    await win.getByTestId('section-header-changes').hover();
    await win.getByTestId('add-below-changes').click();
    const menu = win.getByTestId('left-sidebar-add-menu');
    await expect(menu.getByTestId('add-tool-scratchpad')).toBeVisible();
    await menu.getByTestId('add-section-files').click();
    await expect(win.getByTestId('section-header-files')).toHaveAttribute('data-expanded', 'true');
    await expect.poll(() => leftPanes(win)).toEqual(['projects', 'changes', 'files', USAGE]);
    await expect.poll(async () => (await paneview(win)).paneview.hidden).toEqual([]);

    // With every section open the menu says so.
    await win.getByTestId('section-header-files').hover();
    await win.getByTestId('add-below-files').click();
    await expect(win.getByTestId('add-section-none')).toBeVisible();
    await win.keyboard.press('Escape');

    // Closing everything leaves an empty sidebar that adds sections back.
    for (const id of ['projects', 'changes', 'files', USAGE]) await closeSection(win, id);
    await expect(win.getByTestId('sidebar-empty')).toBeVisible();
    // Closed sections keep their height for when they come back.
    await win.waitForTimeout(700);
    expect((await paneview(win)).paneview.sizes['changes']).toBeGreaterThan(80);
    await win.getByTestId('sidebar-add-section').click();
    await win.getByTestId('left-sidebar-add-menu').getByTestId('add-section-projects').click();
    await expect(win.getByTestId('section-header-projects')).toBeVisible();
    await expect(win.getByTestId('sidebar-empty')).toHaveCount(0);

    // View: Focus Changes (Ctrl+Shift+G) brings a closed section back and focuses it.
    await win.keyboard.press('Control+Shift+KeyG');
    await expect(win.getByTestId('section-header-changes')).toHaveAttribute('data-expanded', 'true');
    await expect.poll(() => leftPanes(win)).toEqual(['projects', 'changes']);

    // Tools can be added to the left sidebar from the same menu.
    await win.getByTestId('section-header-changes').hover();
    await win.getByTestId('add-below-changes').click();
    await win.getByTestId('left-sidebar-add-menu').getByTestId('add-tool-scratchpad').click();
    await expect(win.getByTestId('sidebar').getByTestId('scratchpad-input')).toBeVisible();
    await expect.poll(async () => (await paneview(win)).primaryTools.map((t) => t.kind)).toEqual(['scratchpad']);
    await win.waitForTimeout(700); // debounced persistence
  } finally {
    await first.app.close();
  }

  const second = await launchApp({ userData });
  try {
    const { win } = second;
    await expect(win.getByTestId('section-header-changes')).toBeVisible();
    await expect.poll(() => leftPanes(win)).toEqual(['projects', 'changes', 'scratchpad']);
    // The Usage view of the plugin stays closed too.
    await win.waitForTimeout(1000);
    await expect(win.getByTestId(`section-header-${USAGE}`)).toHaveCount(0);
    expect((await paneview(win)).paneview.hidden.sort()).toEqual(['files', USAGE].sort());
  } finally {
    await second.app.close();
  }
});
