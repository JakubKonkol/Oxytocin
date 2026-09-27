import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { nodeCmd, oxyTest, run, waitForPrompt, waitForTerminal } from './helpers/terminal';

test('floating groups: move a panel out and back, keep its terminal, survive a restart', async () => {
  const first = await launchApp();
  const { userData } = first;
  let floatingPanel = '';
  try {
    const t = oxyTest(first.win);
    const term = await waitForTerminal(first.win);
    await first.win.keyboard.press('Alt+Shift+Equal');
    await expect.poll(async () => (await t.workspace())?.panels.length).toBe(2);
    const second = (await t.workspace())!.panels.find((p) => p.terminalId !== term)!;
    floatingPanel = second.id;
    await waitForPrompt(first.win, second.terminalId!);
    await first.win.getByTestId(`terminal-view-${second.terminalId}`).click();
    await run(first.win, nodeCmd("console.log('float-' + 'me')"));
    await expect.poll(() => t.text(second.terminalId!)).toContain('float-me');
    const dockedRows = (await t.size(second.terminalId!))!.rows;

    // Tab context menu: "Move to new floating group".
    await first.win.getByTestId(`tab-${second.id}`).click({ button: 'right' });
    await first.win.getByText('Move to new floating group').click();
    await expect.poll(async () => (await t.workspace())?.panels.find((p) => p.id === second.id)?.floating).toBe(true);
    await expect(first.win.locator('.dv-resize-container')).toHaveCount(1);
    // The floating group is 60 % of the workspace height: wait for the terminal to fit it and the shell to redraw
    // its prompt. Typing during the resize lets readline redraw a wrapped command line with the old width, which
    // moves up one row too many and erases the output above it (float-me) on narrow CI terminals.
    await expect.poll(async () => (await t.size(second.terminalId!))!.rows).toBeLessThan(dockedRows);
    await waitForPrompt(first.win, second.terminalId!);
    // Same terminal, same buffer, still interactive.
    expect((await t.workspace())!.panels.find((p) => p.id === second.id)?.terminalId).toBe(second.terminalId);
    await first.win.getByTestId(`terminal-view-${second.terminalId}`).click();
    await run(first.win, nodeCmd("console.log('still-' + 'typing')"));
    await expect.poll(() => t.text(second.terminalId!)).toContain('still-typing');
    expect(await t.text(second.terminalId!)).toContain('float-me');
    await first.win.waitForTimeout(1300);
  } finally {
    await first.app.close();
  }

  // The floating group is part of the saved layout.
  const second = await launchApp({ userData });
  try {
    const t = oxyTest(second.win);
    await expect(second.win.getByTestId('app-ready')).toBeVisible();
    await expect
      .poll(async () => (await t.workspace())?.panels.find((p) => p.id === floatingPanel)?.floating)
      .toBe(true);
    // Docked back from the command palette.
    await second.win.getByTestId(`tab-${floatingPanel}`).click();
    await second.win.keyboard.press('Control+Shift+KeyP');
    await second.win.keyboard.type('dock floating panel');
    await second.win.keyboard.press('Enter');
    await expect
      .poll(async () => (await t.workspace())?.panels.find((p) => p.id === floatingPanel)?.floating)
      .toBe(false);
    await expect(second.win.locator('.dv-resize-container')).toHaveCount(0);
  } finally {
    await second.app.close();
  }
});
