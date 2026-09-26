import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';

test('the renderer is sandboxed and served from app://', async () => {
  const { app, win } = await launchApp();
  try {
    expect(win.url()).toBe('app://oxytocin/index.html');
    const globals = await win.evaluate(() => ({
      hasOxy: typeof (window as unknown as { oxy?: unknown }).oxy === 'object',
      hasRequire: typeof (window as unknown as { require?: unknown }).require !== 'undefined',
      hasProcess: typeof (window as unknown as { process?: unknown }).process !== 'undefined',
    }));
    expect(globals).toEqual({ hasOxy: true, hasRequire: false, hasProcess: false });
  } finally {
    await app.close();
  }
});

test('navigation away from the shell origin is blocked', async () => {
  const { app, win } = await launchApp();
  try {
    await win.evaluate(() => {
      window.location.href = 'https://example.com/';
    });
    await win.waitForTimeout(500);
    expect(win.url()).toBe('app://oxytocin/index.html');
  } finally {
    await app.close();
  }
});
