import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';

test('the main window opens with the Oxytocin title and the shell layout', async () => {
  const { app, win } = await launchApp();
  try {
    await expect(win).toHaveTitle(/Oxytocin/);
    expect(app.windows()).toHaveLength(1);
    await expect(win.getByTestId('titlebar')).toContainText('Oxytocin');
    for (const id of ['projects', 'changes', 'plugin:oxytocin.usage-monitor:usage.sidebar']) {
      await expect(win.getByTestId(`section-header-${id}`)).toBeVisible();
    }
    await expect(win.getByTestId('statusbar')).toBeVisible();
    await expect(win.getByTestId('center')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('sidebar width and collapsed sections persist across restarts', async () => {
  const first = await launchApp();
  const { userData } = first;
  try {
    const win = first.win;
    const resizer = win.getByTestId('sidebar-resizer');
    const box = (await resizer.boundingBox())!;
    await win.mouse.move(box.x + box.width / 2, box.y + 200);
    await win.mouse.down();
    await win.mouse.move(box.x + box.width / 2 + 80, box.y + 200, { steps: 5 });
    await win.mouse.up();
    await expect.poll(async () => (await win.getByTestId('sidebar').boundingBox())?.width).toBe(380);
    await win.getByTestId('section-header-changes').getByRole('button', { name: 'CHANGES', exact: true }).click();
    await expect(win.getByTestId('section-header-changes')).toHaveAttribute('data-expanded', 'false');
    // Closing the app writes what is still pending (ui-state.json is otherwise written with a short delay).
  } finally {
    await first.app.close();
  }

  const second = await launchApp({ userData });
  try {
    await expect.poll(async () => (await second.win.getByTestId('sidebar').boundingBox())?.width).toBe(380);
    await expect(second.win.getByTestId('section-header-changes')).toHaveAttribute('data-expanded', 'false');
    await expect(second.win.getByTestId('section-header-projects')).toHaveAttribute('data-expanded', 'true');
  } finally {
    await second.app.close();
  }
});

test('Ctrl+Shift+B toggles the sidebar and the state persists', async () => {
  const first = await launchApp();
  try {
    await expect(first.win.getByTestId('sidebar')).toBeVisible();
    await first.win.keyboard.press('Control+Shift+KeyB');
    await expect(first.win.getByTestId('sidebar')).toHaveCount(0);
  } finally {
    await first.app.close();
  }
  const second = await launchApp({ userData: first.userData });
  try {
    await expect(second.win.getByTestId('app-ready')).toBeVisible();
    await expect(second.win.getByTestId('sidebar')).toHaveCount(0);
    // View: Focus Changes works after a start with the sidebar hidden: it opens the sidebar.
    await second.win.keyboard.press('Control+Shift+KeyG');
    await expect(second.win.getByTestId('section-header-changes')).toHaveAttribute('data-expanded', 'true');
  } finally {
    await second.app.close();
  }
});
