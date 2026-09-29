import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { interrupt, nodeCmd, oxyTest, run, waitForTerminal } from './helpers/terminal';

test('split right and down create independent terminals', async () => {
  const { app, win } = await launchApp();
  try {
    const t = oxyTest(win);
    const first = await waitForTerminal(win);
    await win.keyboard.press('Alt+Shift+Equal');
    await expect.poll(async () => (await t.workspace())?.panels.length).toBe(2);
    await win.keyboard.press('Alt+Shift+Minus');
    await expect.poll(async () => (await t.workspace())?.groups).toBe(3);
    const ws = (await t.workspace())!;
    const ids = ws.panels.map((p) => p.terminalId!);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toContain(first);

    for (const [i, id] of ids.entries()) {
      await win.getByTestId(`terminal-view-${id}`).click();
      await expect.poll(() => t.text(id)).not.toBe('');
      await run(win, nodeCmd(`console.log('pane-' + ${i})`));
      await expect.poll(() => t.text(id)).toContain(`pane-${i}`);
    }
    for (const [i, id] of ids.entries()) {
      for (const other of [0, 1, 2].filter((n) => n !== i)) {
        expect(await t.text(id)).not.toContain(`pane-${other}\n`);
      }
    }
  } finally {
    await app.close();
  }
});

test('moving a panel into another group keeps its buffer and process', async () => {
  const { app, win } = await launchApp();
  try {
    const t = oxyTest(win);
    const first = await waitForTerminal(win);
    await run(win, nodeCmd("console.log('keep-' + 'me'); setInterval(() => {}, 1000)"));
    await expect.poll(() => t.text(first)).toContain('keep-me');
    await win.keyboard.press('Alt+Shift+Equal');
    await expect.poll(async () => (await t.workspace())?.groups).toBe(2);
    const ws = (await t.workspace())!;
    const firstPanel = ws.panels.find((p) => p.terminalId === first)!;
    const second = ws.panels.find((p) => p.terminalId !== first)!;

    // Moves the panel through dockview's move API — the same re-parenting a tab drop performs
    // (Playwright cannot start a native HTML5 drag in Electron).
    expect(await t.movePanel(firstPanel.id, second.id)).toBe(true);
    await expect.poll(async () => (await t.workspace())?.groups).toBe(1);
    const after = (await t.workspace())!;
    expect(after.panels.find((p) => p.id === firstPanel.id)?.terminalId).toBe(first);
    await win.getByTestId(`tab-${firstPanel.id}`).click();
    await expect.poll(() => t.text(first)).toContain('keep-me');
    await win.getByTestId(`terminal-view-${first}`).click();
    await interrupt(win, first);
    await run(win, nodeCmd("console.log('still-' + 'alive')"));
    await expect.poll(() => t.text(first)).toContain('still-alive');
  } finally {
    await app.close();
  }
});

test('maximize, focus and resize with the keyboard', async () => {
  const { app, win } = await launchApp();
  try {
    const t = oxyTest(win);
    await waitForTerminal(win);
    await win.keyboard.press('Alt+Shift+Equal');
    await expect.poll(async () => (await t.workspace())?.groups).toBe(2);
    const right = (await t.workspace())!.activeGroup!;
    const rightTerminal = (await t.workspace())!.panels.find((p) => p.group === right.id)!.terminalId;
    await expect.poll(() => t.activeTerminalId()).toBe(rightTerminal);

    await win.keyboard.press('Alt+ArrowLeft');
    await expect.poll(async () => (await t.workspace())?.activeGroup?.id).not.toBe(right.id);
    const leftWidth = (await t.workspace())!.activeGroup!.width;
    await win.keyboard.press('Alt+Shift+ArrowRight');
    await expect.poll(async () => (await t.workspace())!.activeGroup!.width).toBeGreaterThan(leftWidth);

    await win.keyboard.press('Control+Shift+Enter');
    await expect.poll(async () => (await t.workspace())?.maximized).toBe(true);
    await win.keyboard.press('Control+Shift+Enter');
    await expect.poll(async () => (await t.workspace())?.maximized).toBe(false);
  } finally {
    await app.close();
  }
});

test('closing a panel kills its terminal; renaming a tab updates the title', async () => {
  const { app, win } = await launchApp();
  try {
    const t = oxyTest(win);
    const first = await waitForTerminal(win);
    await win.keyboard.press('Control+Shift+KeyT');
    await expect.poll(async () => (await t.workspace())?.panels.length).toBe(2);
    const second = (await t.workspace())!.panels.find((p) => p.terminalId !== first)!;

    await win.getByTestId(`tab-${second.id}`).getByTestId('tab-title').dblclick();
    await win.getByTestId('tab-rename-input').fill('API server');
    await win.keyboard.press('Enter');
    await expect(win.getByTestId(`tab-${second.id}`).getByTestId('tab-title')).toHaveText('API server');
    // Rename from the tab's context menu.
    await win.getByTestId(`terminal-view-${second.terminalId}`).click();
    const tab = (await win.getByTestId(`tab-${second.id}`).boundingBox())!;
    await win.mouse.move(tab.x + 20, tab.y + tab.height / 2);
    await win.mouse.down({ button: 'right' });
    await win.mouse.up({ button: 'right' });
    const item = (await win.getByRole('menuitem', { name: 'Rename' }).boundingBox())!;
    await win.mouse.move(item.x + 10, item.y + item.height / 2, { steps: 5 });
    await win.mouse.down();
    await win.mouse.up();
    const input = win.getByTestId('tab-rename-input');
    await expect(input).toBeFocused();
    await win.waitForTimeout(1000);
    await expect(input).toBeFocused();
    await win.keyboard.type('Web server');
    await win.keyboard.press('Enter');
    await expect(win.getByTestId(`tab-${second.id}`).getByTestId('tab-title')).toHaveText('Web server');

    await win.getByTestId(`terminal-view-${second.terminalId}`).click();
    await win.keyboard.press('Control+Shift+KeyW');
    await expect.poll(async () => (await t.workspace())?.panels.length).toBe(1);
    const list = (await win.evaluate(() => window.oxy.invoke('terminals:list', {}))) as { id: string }[];
    expect(list.map((x) => x.id)).toEqual([first]);
  } finally {
    await app.close();
  }
});

test('the profile picker opens a terminal with the chosen profile', async () => {
  const { app, win } = await launchApp();
  try {
    const t = oxyTest(win);
    await waitForTerminal(win);
    await win.keyboard.press('Control+Shift+KeyN');
    const picker = win.getByTestId('profile-picker');
    await expect(picker).toBeVisible();
    await picker.getByRole('button').first().click();
    await expect.poll(async () => (await t.workspace())?.panels.length).toBe(2);
  } finally {
    await app.close();
  }
});
