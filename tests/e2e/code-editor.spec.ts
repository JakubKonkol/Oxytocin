import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { makeRepo } from './helpers/git';
import { launchApp, repoRoot } from './helpers/launch';
import { oxyTest, run, waitForTerminal } from './helpers/terminal';

const fakeClaude = join(repoRoot, 'tests/fixtures/agents/node_modules/@anthropic-ai/claude-code/cli.js');

const fileRow = (win: Page, path: string) =>
  win.getByTestId('files-section').locator(`[data-testid="files-row"][data-path="${path}"]`);

const codePanelId = async (win: Page) =>
  (await oxyTest(win).workspace())?.panels.find((p) => p.id.startsWith('code-'))?.id ?? '';

const APP = "export const a = 1;\nexport const b = 2;\nexport function third(): string {\n  return 'three';\n}\n";

test('browse the project in FILES and edit a file in the built-in editor', async () => {
  const repo = await makeRepo();
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'app.ts'), APP);
  const { app, win } = await launchApp({ project: repo });
  try {
    await waitForTerminal(win);
    // FILES starts collapsed below CHANGES.
    await win.getByTestId('section-header-files').getByRole('button', { expanded: false }).click();
    await expect(fileRow(win, 'src')).toBeVisible();
    await expect(fileRow(win, 'tracked.txt')).toBeVisible();
    await fileRow(win, 'src').click();
    await fileRow(win, 'src/app.ts').click();

    const panel = win.locator('[data-testid="code-panel"][data-path="src/app.ts"]');
    await expect(panel).toBeVisible();
    await expect
      .poll(async () => (await oxyTest(win).code(await codePanelId(win)))?.text, { timeout: 15_000 })
      .toBe(APP);
    await expect(win.getByTestId('tab-title').filter({ hasText: 'app.ts' })).toHaveAttribute('data-preview', 'true');

    // Edit one line and save with Ctrl+S.
    await panel.locator('.view-line').filter({ hasText: 'export const b = 2;' }).click();
    await win.keyboard.press('End');
    await win.keyboard.press('Backspace');
    await win.keyboard.press('Backspace');
    await win.keyboard.type('42;');
    await expect(panel).toHaveAttribute('data-dirty', 'true');
    await expect(win.getByTestId('tab-title').filter({ hasText: '● app.ts' })).toHaveAttribute('data-preview', 'false');
    await win.keyboard.press('Control+s');
    await expect(panel).toHaveAttribute('data-dirty', 'false');
    expect(await readFile(join(repo, 'src', 'app.ts'), 'utf8')).toBe(APP.replace('b = 2;', 'b = 42;'));

    // An agent writes the file: the editor (without edits) shows the new version.
    await writeFile(join(repo, 'src', 'app.ts'), 'export const changed = true;\n');
    await expect
      .poll(async () => (await oxyTest(win).code(await codePanelId(win)))?.text, { timeout: 10_000 })
      .toBe('export const changed = true;\n');

    // With unsaved edits it asks instead of replacing them.
    await panel.locator('.view-line').first().click();
    await win.keyboard.press('End');
    await win.keyboard.type(' // mine');
    await writeFile(join(repo, 'src', 'app.ts'), 'export const agent = 1;\n');
    await expect(panel.getByTestId('code-disk-banner')).toBeVisible({ timeout: 10_000 });
    await panel.getByTestId('code-reload').click();
    await expect
      .poll(async () => (await oxyTest(win).code(await codePanelId(win)))?.text)
      .toBe('export const agent = 1;\n');
    await expect(panel).toHaveAttribute('data-dirty', 'false');

    // New files from the FILES section open in the editor.
    await win.getByTestId('section-header-files').hover();
    await win.getByTestId('files-new-file').click();
    await win.getByTestId('dialog-answer').fill('docs/notes.md');
    await win.getByTestId('confirm-dialog').getByRole('button', { name: 'Create' }).click();
    await expect(win.locator('[data-testid="code-panel"][data-path="docs/notes.md"]')).toBeVisible();
    await expect(fileRow(win, 'docs/notes.md')).toBeVisible();
    expect(await readFile(join(repo, 'docs', 'notes.md'), 'utf8')).toBe('');
  } finally {
    await app.close();
  }
});

test('Quick Open finds project files and "Open in editor" can use the built-in editor', async () => {
  const repo = await makeRepo();
  await mkdir(join(repo, 'src', 'deep'), { recursive: true });
  await writeFile(join(repo, 'src', 'deep', 'needle.ts'), 'export const needle = 1;\n');
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ 'editor.preset': 'oxytocin' }));
  const { app, win } = await launchApp({ userData, project: repo });
  try {
    await waitForTerminal(win);
    await win.keyboard.press('Control+Shift+O');
    await win.keyboard.type('%needle');
    await expect(win.getByRole('option', { name: /needle\.ts/ })).toBeVisible({ timeout: 10_000 });
    await win.keyboard.press('Enter');
    await expect(win.locator('[data-testid="code-panel"][data-path="src/deep/needle.ts"]')).toBeVisible();

    // "Open in External Editor" with editor.preset = oxytocin opens the file here, at the line.
    await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n');
    const row = win.locator('[data-testid="changes-row"][data-path="tracked.txt"]');
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Open in External Editor' }).click();
    await expect(win.locator('[data-testid="code-panel"][data-path="tracked.txt"]')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Ask agent sends the selected code with an instruction to the running agent', async () => {
  const repo = await makeRepo();
  await writeFile(join(repo, 'app.ts'), APP);
  const claudeDir = await mkdtemp(join(tmpdir(), 'oxy-e2e-claude-'));
  const { app, win } = await launchApp({ project: repo, env: { CLAUDE_CONFIG_DIR: claudeDir } });
  try {
    const id = await waitForTerminal(win);
    await win.locator(`[data-terminal-id="${id}"] .xterm`).click();
    await run(win, `node "${fakeClaude}"`);
    await expect.poll(() => oxyTest(win).text(id)).toContain('fake-claude>');
    await expect(win.getByTestId('terminal-kind-badge')).toHaveText('AI AGENT', { timeout: 10_000 });

    await win.getByTestId('section-header-files').getByRole('button', { expanded: false }).click();
    await fileRow(win, 'app.ts').dblclick();
    const panel = win.locator('[data-testid="code-panel"][data-path="app.ts"]');
    const line = panel.locator('.view-line').filter({ hasText: "return 'three';" });
    await expect(line).toBeVisible({ timeout: 15_000 });
    await line.click();
    await win.keyboard.press('Home');
    await win.keyboard.press('Shift+End');
    await win.keyboard.press('Control+l');

    const dialog = win.getByTestId('ask-agent-dialog');
    await expect(dialog.getByTestId('ask-agent-code')).toContainText("return 'three';");
    await expect(dialog.getByTestId('ask-agent-contexts')).toContainText('line 4');
    await dialog.getByTestId('ask-agent-preset-explain').click();
    await dialog.getByTestId('ask-agent-send').click();
    await expect.poll(() => oxyTest(win).text(id), { timeout: 10_000 }).toContain('Explain what this code does');
    await expect.poll(() => oxyTest(win).text(id)).toContain("return 'three';");
  } finally {
    await app.close();
  }
});
