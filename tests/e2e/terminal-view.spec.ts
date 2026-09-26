import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { nodeCmd, oxyTest, run, waitForTerminal } from './helpers/terminal';

test('a terminal starts with a prompt, echoes input and renders ANSI colors', async () => {
  const { app, win } = await launchApp();
  try {
    const id = await waitForTerminal(win);
    const t = oxyTest(win);
    await run(win, nodeCmd("console.log('hello-' + 'oxy')"));
    await expect.poll(() => t.text(id)).toContain('hello-oxy');
    await run(
      win,
      nodeCmd("console.log(String.fromCharCode(27) + '[31m' + 'RED' + 'TEXT' + String.fromCharCode(27) + '[0m')"),
    );
    await expect.poll(() => t.color(id, 'REDTEXT')).toMatchObject({ palette: true, fg: 1 });
    // Non-ASCII input goes through the textarea's input event (IME / keyboard layouts).
    await win.keyboard.insertText("node -e \"console.log('zażółć ' + 'gęślą 🚀')\"");
    await win.keyboard.press('Enter');
    await expect.poll(() => t.text(id)).toContain('zażółć gęślą 🚀');
  } finally {
    await app.close();
  }
});

test('a renderer reload restores the buffer and the process keeps running', async () => {
  const { app, win } = await launchApp();
  try {
    const id = await waitForTerminal(win);
    await run(win, nodeCmd("console.log('before-' + 'reload')"));
    await expect.poll(() => oxyTest(win).text(id)).toContain('before-reload');
    await win.reload();
    const idAfter = await waitForTerminal(win);
    expect(idAfter).toBe(id);
    await expect.poll(() => oxyTest(win).text(id)).toContain('before-reload');
    await win.getByTestId(`terminal-view-${id}`).click();
    await run(win, nodeCmd("console.log('after-' + 'reload')"));
    await expect.poll(() => oxyTest(win).text(id)).toContain('after-reload');
  } finally {
    await app.close();
  }
});

test('the terminal size follows the window', async () => {
  const { app, win } = await launchApp();
  try {
    const id = await waitForTerminal(win);
    const before = await oxyTest(win).size(id);
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      w.unmaximize();
      w.setSize(1500, 900);
    });
    await expect.poll(async () => (await oxyTest(win).size(id))?.cols).toBeGreaterThan(before!.cols);
    await run(win, nodeCmd("console.log('cols=' + process.stdout.columns)"));
    const size = await oxyTest(win).size(id);
    await expect.poll(() => oxyTest(win).text(id)).toContain(`cols=${size!.cols}`);
  } finally {
    await app.close();
  }
});
