import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { waitForTerminal } from './helpers/terminal';

test('the workspace shows a terminal panel with a card header', async () => {
  const { app, win } = await launchApp();
  try {
    await waitForTerminal(win);
    const tab = win.locator('[data-testid^="tab-term-"]').first();
    await expect(tab).toBeVisible();
    await expect(tab).toContainText('SHELL');
    await expect(tab.getByRole('img', { name: 'Idle' })).toBeVisible();
    await expect(win.locator('.dv-groupview.dv-active-group')).toHaveCount(1);
  } finally {
    await app.close();
  }
});
