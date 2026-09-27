import { expect, test, type ElectronApplication } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { interrupt, nodeCmd, oxyTest, run, waitForTerminal } from './helpers/terminal';

const readClipboard = (app: ElectronApplication) => app.evaluate(({ clipboard }) => clipboard.readText());
const writeClipboard = (app: ElectronApplication, text: string) =>
  app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text);

test('Ctrl+C interrupts a running process and copies a selection', async () => {
  const { app, win } = await launchApp();
  try {
    const id = await waitForTerminal(win);
    const t = oxyTest(win);
    await run(win, nodeCmd("console.log('long-' + 'running'); setInterval(() => {}, 1000)"));
    await expect.poll(() => t.text(id)).toContain('long-running');
    await interrupt(win, id);
    await run(win, nodeCmd("console.log('after-' + 'interrupt')"));
    await expect.poll(() => t.text(id)).toContain('after-interrupt');

    expect(await t.select(id, 'after-interrupt')).toBe(true);
    await win.keyboard.press('Control+C');
    await expect.poll(() => readClipboard(app)).toBe('after-interrupt');
  } finally {
    await app.close();
  }
});

test('Ctrl+V pastes clipboard text', async () => {
  const { app, win } = await launchApp();
  try {
    const id = await waitForTerminal(win);
    await writeClipboard(app, nodeCmd("console.log('pasted-' + 'ok')"));
    await win.keyboard.press('Control+V');
    // The paste reads the clipboard asynchronously: wait for the echo before submitting.
    await expect.poll(() => oxyTest(win).text(id)).toContain("'pasted-'");
    await win.keyboard.press('Enter');
    await expect.poll(() => oxyTest(win).text(id)).toContain('pasted-ok');
  } finally {
    await app.close();
  }
});

test('Shift+Enter sends ESC CR (newline in Claude Code)', async () => {
  const { app, win } = await launchApp();
  try {
    const id = await waitForTerminal(win);
    await run(
      win,
      nodeCmd(
        "process.stdin.setRawMode(true); console.log('raw-' + 'ready'); process.stdin.on('data', (d) => { console.log('bytes=' + [...d].join(',')); process.exit(0); })",
      ),
    );
    await expect.poll(() => oxyTest(win).text(id)).toContain('raw-ready');
    await win.keyboard.press('Shift+Enter');
    await expect.poll(() => oxyTest(win).text(id)).toContain('bytes=27,13');
  } finally {
    await app.close();
  }
});

test('multi-line paste without bracketed paste mode asks for confirmation', async () => {
  const { app, win } = await launchApp();
  try {
    const id = await waitForTerminal(win);
    await run(
      win,
      nodeCmd(
        "process.stdin.on('data', (d) => console.log('got=' + JSON.stringify(String(d)))); console.log('reader-' + 'ready')",
      ),
    );
    await expect.poll(() => oxyTest(win).text(id)).toContain('reader-ready');
    await writeClipboard(app, 'first line\nsecond line');
    await win.keyboard.press('Control+V');
    await expect(win.getByRole('alertdialog')).toContainText('Paste 2 lines?');
    await win.getByRole('button', { name: 'Cancel' }).click();
    await expect(win.getByRole('alertdialog')).toHaveCount(0);
    expect(await oxyTest(win).text(id)).not.toContain('first line');
    await win.getByTestId(`terminal-view-${id}`).click();
    await win.keyboard.press('Control+V');
    await win.getByRole('button', { name: 'Paste' }).click();
    await expect.poll(() => oxyTest(win).text(id)).toContain('first line');
    await win.keyboard.press('Control+C');
  } finally {
    await app.close();
  }
});

test('app shortcuts work inside the terminal while plain Ctrl+letter reaches the shell', async () => {
  const { app, win } = await launchApp();
  try {
    const id = await waitForTerminal(win);
    await expect(win.getByTestId('sidebar')).toBeVisible();
    await win.keyboard.press('Control+Shift+KeyB');
    await expect(win.getByTestId('sidebar')).toHaveCount(0);
    await win.keyboard.press('Control+Shift+KeyB');
    await expect(win.getByTestId('sidebar')).toBeVisible();
    await win.getByTestId(`terminal-view-${id}`).click();
    await win.keyboard.press('Control+B');
    await expect(win.getByTestId('sidebar')).toBeVisible();
  } finally {
    await app.close();
  }
});
