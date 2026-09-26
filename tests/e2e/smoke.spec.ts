import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';

test('the main window opens with the Oxytocin title', async () => {
  const { app, win } = await launchApp();
  try {
    await expect(win).toHaveTitle(/Oxytocin/);
    expect(app.windows()).toHaveLength(1);
  } finally {
    await app.close();
  }
});
