import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, repoRoot } from './helpers/launch';

test('app menu: About Oxytocin with version and MIT license, third-party notices', async () => {
  const { version } = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as { version: string };
  const { app, win } = await launchApp({ project: null });
  try {
    await win.getByTestId('app-menu').click();
    await win.getByRole('menuitem', { name: 'About Oxytocin' }).click();
    const about = win.getByTestId('about-dialog');
    await expect(about.getByTestId('about-version')).toContainText(`Version ${version}`);
    await expect(about).toContainText('Released under the MIT License');
    await about.getByRole('button', { name: 'MIT License' }).click();
    await expect(win.getByTestId('legal-license')).toContainText('Permission is hereby granted, free of charge');
    await win.getByRole('button', { name: 'Close' }).click();
    await expect(win.getByTestId('legal-license')).toHaveCount(0);

    await win.getByTestId('app-menu').click();
    await win.getByRole('menuitem', { name: 'Third-Party Notices' }).click();
    await expect(win.getByTestId('legal-notices')).toContainText('## react');
    await win.keyboard.press('Escape');
    await expect(win.getByTestId('legal-notices')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('the keyboard button of the title bar lists every shortcut, searchable, with a way to customize them', async () => {
  const { app, win } = await launchApp();
  try {
    await expect(win.getByTestId('app-ready')).toBeVisible();
    await win.getByTestId('open-shortcuts').click();
    const dialog = win.getByTestId('shortcuts-dialog');
    await expect(dialog).toBeVisible();
    const view = dialog.locator('[data-testid="shortcuts-group"][data-group="View"]');
    await expect(view.getByTestId('shortcut-entry').filter({ hasText: 'Toggle Sidebar' })).toContainText(
      'Ctrl+Shift+B',
    );
    await expect(dialog.locator('[data-testid="shortcuts-group"][data-group="Editor and Diffs"]')).toContainText(
      'Ask an agent about the selection',
    );
    await expect(dialog.locator('[data-testid="shortcuts-group"][data-group="Projects"]')).toContainText(
      'Open project 1–9',
    );

    // The search filters titles, categories and keys.
    await dialog.getByTestId('shortcuts-search').fill('ctrl+shift+b');
    await expect(dialog.getByTestId('shortcut-entry')).toHaveCount(1);
    await expect(dialog.getByTestId('shortcut-entry')).toContainText('Toggle Sidebar');
    await win.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // Ctrl+Shift+/ toggles it; "Customize…" opens the Keyboard Shortcuts editor.
    await win.keyboard.press('Control+Shift+Slash');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('shortcuts-search')).toHaveValue('');
    await dialog.getByTestId('shortcuts-customize').click();
    await expect(dialog).toHaveCount(0);
    await expect(win.getByTestId('keybindings-panel')).toBeVisible();
  } finally {
    await app.close();
  }
});
