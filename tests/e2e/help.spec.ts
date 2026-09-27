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
