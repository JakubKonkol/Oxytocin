import { expect, type Frame, type Page, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { oxyTest, waitForTerminal } from './helpers/terminal';

async function jsonFrame(win: Page): Promise<Frame> {
  let frame: Frame | undefined;
  await expect
    .poll(
      () =>
        (frame = win
          .frames()
          .find((f) => f.url().startsWith('oxy-plugin://oxytocin.json-formatter/') && !f.isDetached())),
      { timeout: 15_000 },
    )
    .toBeTruthy();
  return frame!;
}

const uiState = (win: Page) =>
  win.evaluate(() => window.oxy.invoke('ui:getState')) as Promise<{
    secondaryTools: { id: string; kind: string; panelType?: string }[];
  }>;

test('the "+" menu opens tools next to terminals, and tools move to and from the right sidebar', async () => {
  test.setTimeout(90_000);
  const { app, win } = await launchApp({ secondarySidebar: true });
  try {
    await waitForTerminal(win);
    const sidebar = win.getByTestId('secondary-sidebar');

    // "+" → Tools → JSON Formatter opens in the terminal's group.
    await win.getByTestId('group-add').first().click();
    const menu = win.getByTestId('group-add-menu');
    await expect(menu.getByTestId('add-terminal')).toBeVisible();
    await expect(menu.getByTestId('add-tool-scratchpad')).toBeVisible();
    await menu.getByTestId('add-tool-plugin:json.formatter').click();
    await expect.poll(async () => (await oxyTest(win).workspace())?.panels.length).toBe(2);
    let frame = await jsonFrame(win);
    await frame.getByTestId('json-input').fill('{"b":1,"a":[true,null]}');
    await frame.getByTestId('json-format').click();
    await expect(frame.getByTestId('json-status')).toHaveText('Valid JSON · object · 2 keys');
    await expect(frame.getByTestId('json-input')).toHaveValue('{\n  "b": 1,\n  "a": [\n    true,\n    null\n  ]\n}');
    // Invalid JSON: the error with its position.
    await frame.getByTestId('json-input').fill('{\n  "a": }');
    await frame.getByTestId('json-minify').click();
    await expect(frame.getByTestId('json-status')).toContainText('Line 2, column 8');
    await frame.getByTestId('json-input').fill('[1, 2]');
    // Let the view save its state (debounced) before moving it.
    await win.waitForTimeout(600);

    // Drag the tab onto the lower half of the scratchpad section: it lands below the scratchpad.
    const tab = win.locator('.dv-tab').filter({ hasText: 'JSON Formatter' });
    const target = sidebar.getByTestId('scratchpad-input');
    const box = (await target.boundingBox())!;
    await tab.dragTo(target, { targetPosition: { x: box.width / 2, y: box.height - 10 } });
    await expect(sidebar.getByTestId('sidebar-tool-json.formatter')).toBeVisible();
    await expect.poll(async () => (await oxyTest(win).workspace())?.panels.length).toBe(1);
    frame = await jsonFrame(win);
    // The view keeps its text.
    await expect(frame.getByTestId('json-input')).toHaveValue('[1, 2]');
    await expect
      .poll(async () => (await uiState(win)).secondaryTools.map((t) => t.panelType ?? t.kind))
      .toEqual(['scratchpad', 'json.formatter']);

    // Back to the workspace with the section's "Move to workspace" action.
    const toolId = (await uiState(win)).secondaryTools.find((t) => t.kind === 'plugin')!.id;
    await win.getByTestId(`section-header-${toolId}`).hover();
    await win.getByTestId(`move-tool-${toolId}`).click();
    await expect.poll(async () => (await oxyTest(win).workspace())?.panels.length).toBe(2);
    await expect(sidebar.getByTestId('sidebar-tool-json.formatter')).toHaveCount(0);
    frame = await jsonFrame(win);
    await expect(frame.getByTestId('json-input')).toHaveValue('[1, 2]');

    // The tab context menu moves it to the sidebar as well.
    await win.locator('.dv-tab').filter({ hasText: 'JSON Formatter' }).click({ button: 'right' });
    await win.getByText('Move to right sidebar').click();
    await expect(sidebar.getByTestId('sidebar-tool-json.formatter')).toBeVisible();

    // Dragging its section header onto the right edge of the terminal splits the layout.
    const header = sidebar.locator('[data-testid^="section-header-tool-"]');
    const terminal = win.locator('[data-terminal-id]').first();
    const area = (await terminal.boundingBox())!;
    await header.dragTo(terminal, { targetPosition: { x: area.width - 15, y: area.height / 2 } });
    await expect.poll(async () => (await oxyTest(win).workspace())?.groups).toBe(2);
    await expect(sidebar.getByTestId('sidebar-tool-json.formatter')).toHaveCount(0);
    frame = await jsonFrame(win);
    await expect(frame.getByTestId('json-input')).toHaveValue('[1, 2]');

    // Closing every tool leaves an empty sidebar that can add them again.
    await sidebar.getByTestId('section-header-scratchpad').hover();
    await sidebar.getByTestId('close-tool-scratchpad').click();
    await expect(sidebar.getByTestId('secondary-sidebar-empty')).toBeVisible();
    await expect.poll(async () => (await uiState(win)).secondaryTools).toEqual([]);
    await sidebar.getByTestId('sidebar-add-tool').click();
    await win.getByTestId('sidebar-add-tool-menu').getByTestId('add-tool-scratchpad').click();
    await expect(sidebar.getByTestId('scratchpad-input')).toBeVisible();
    await expect(sidebar.getByTestId('scratchpad-input')).toBeFocused();
  } finally {
    await app.close();
  }
});

test('the scratchpad formats Markdown, has its own settings and opens as a workspace panel', async () => {
  const { app, win } = await launchApp({ secondarySidebar: true });
  try {
    await waitForTerminal(win);
    const sidebar = win.getByTestId('secondary-sidebar');
    const input = sidebar.getByTestId('scratchpad-input');
    await input.fill('fix the bug');
    // Select "bug" and make it bold with the toolbar, then italic with Ctrl+I.
    await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(8, 11));
    await sidebar.getByTestId('scratchpad-format-bold').click();
    await expect(input).toHaveValue('fix the **bug**');
    await input.press('Control+i');
    await expect(input).toHaveValue('fix the **_bug_**');
    // Undo goes back through the formatting.
    await input.press('Control+z');
    await expect(input).toHaveValue('fix the **bug**');

    // Lists continue on Enter and end on an empty item.
    await input.fill('');
    await sidebar.getByTestId('scratchpad-format-bullet').click();
    await input.pressSequentially('first');
    await input.press('Enter');
    await input.pressSequentially('second');
    await input.press('Enter');
    await input.press('Enter');
    await expect(input).toHaveValue('- first\n- second\n');

    // Font and size from the settings popover (the scratchpad.* settings).
    await sidebar.getByTestId('section-header-scratchpad').hover();
    await sidebar.getByTestId('scratchpad-settings').click();
    const popover = win.getByTestId('scratchpad-settings-popover');
    await popover.getByTestId('scratchpad-font-serif').click();
    await popover.getByTestId('scratchpad-font-larger').click();
    await expect(popover.getByTestId('scratchpad-font-size')).toHaveText('13px');
    await expect(input).toHaveCSS('font-size', '13px');
    await expect.poll(() => input.evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Georgia');
    // A settings round trip updates the (controlled) checkbox.
    await popover.getByTestId('scratchpad-toolbar-toggle').click();
    await expect(popover.getByTestId('scratchpad-toolbar-toggle')).not.toBeChecked();
    await expect(sidebar.getByTestId('scratchpad-format-bold')).toHaveCount(0);
    await expect
      .poll(async () => {
        const s = (await win.evaluate(() => window.oxy.invoke('settings:get'))) as Record<string, unknown>;
        return [s['scratchpad.fontFamily'], s['scratchpad.fontSize'], s['scratchpad.formattingToolbar']];
      })
      .toEqual(['serif', 13, false]);
    await win.keyboard.press('Escape');

    // "+" → Tools → Scratchpad: the same notes in a workspace panel.
    await win.getByTestId('group-add').first().click();
    await win.getByTestId('group-add-menu').getByTestId('add-tool-scratchpad').click();
    const panel = win.getByTestId('scratchpad-panel');
    await expect(panel.getByTestId('scratchpad-input')).toHaveValue('- first\n- second\n');
  } finally {
    await app.close();
  }
});
