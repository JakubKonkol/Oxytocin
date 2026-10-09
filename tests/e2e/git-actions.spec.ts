import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { git, makeRepo } from './helpers/git';
import { launchApp, repoRoot } from './helpers/launch';
import { oxyTest, run, waitForTerminal } from './helpers/terminal';

const fakeClaude = join(repoRoot, 'tests/fixtures/agents/node_modules/@anthropic-ai/claude-code/cli.js');

const row = (win: Page, path: string) =>
  win.getByTestId('changes-section').locator(`[data-testid="changes-row"][data-path="${path}"]`);

async function repoWithIdentity(): Promise<string> {
  const repo = await makeRepo();
  git(repo, 'config', 'user.name', 'E2E');
  git(repo, 'config', 'user.email', 'e2e@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  return repo;
}

test('stage, commit, undo and discard from the CHANGES section', async () => {
  const repo = await repoWithIdentity();
  const { app, win } = await launchApp({ project: repo });
  try {
    await waitForTerminal(win);
    await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n');
    await writeFile(join(repo, 'new.txt'), 'new\n');
    await expect(row(win, 'new.txt')).toBeVisible({ timeout: 10_000 });
    await expect(win.getByTestId('commit-button')).toContainText('Commit all 2');

    // Stage one file with its checkbox: the commit only takes the staged file.
    await row(win, 'new.txt').getByTestId('changes-stage').click();
    await expect(row(win, 'new.txt').getByTestId('changes-stage')).toHaveAttribute('data-state', 'all');
    await expect(row(win, 'new.txt').getByTestId('changes-status-letter')).toHaveText('A');
    await expect(win.getByTestId('commit-button')).toContainText('Commit 1 staged');
    await win.getByTestId('commit-message').fill('feat: add new.txt');
    await win.getByTestId('commit-message').press('Control+Enter');
    await expect(row(win, 'new.txt')).toHaveCount(0, { timeout: 10_000 });
    await expect(row(win, 'tracked.txt')).toBeVisible();
    expect(git(repo, 'log', '-1', '--format=%s').toString().trim()).toBe('feat: add new.txt');
    await expect(win.getByTestId('commit-message')).toHaveValue('');

    // Undo the commit: its file comes back staged.
    await win.getByTestId('commit-menu').click();
    await win.getByTestId('commit-undo').click();
    await win.getByTestId('confirm-dialog').getByRole('button', { name: 'Undo commit' }).click();
    await expect(row(win, 'new.txt')).toBeVisible({ timeout: 10_000 });
    await expect(row(win, 'new.txt').getByTestId('changes-stage')).toHaveAttribute('data-state', 'all');
    expect(git(repo, 'log', '-1', '--format=%s').toString().trim()).toBe('init');

    // Discard a modified file from its hover action (after a confirmation).
    await row(win, 'tracked.txt').hover();
    await row(win, 'tracked.txt').getByTestId('changes-discard').click();
    await win.getByTestId('confirm-dialog').getByRole('button', { name: 'Discard' }).click();
    await expect(row(win, 'tracked.txt')).toHaveCount(0, { timeout: 10_000 });
    expect(await readFile(join(repo, 'tracked.txt'), 'utf8')).toBe('one\n');

    // Create a branch from the branch menu.
    await win.getByTestId('changes-branch-menu').click();
    await win.getByTestId('branch-create').click();
    await win.getByTestId('dialog-answer').fill('feature/e2e');
    await win.getByTestId('confirm-dialog').getByRole('button', { name: 'Create and switch' }).click();
    await expect(win.getByTestId('changes-branch')).toHaveText('feature/e2e', { timeout: 10_000 });
    await expect(win.getByTestId('changes-publish')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('push publishes the branch to its remote', async () => {
  const repo = await repoWithIdentity();
  const remote = await mkdtemp(join(tmpdir(), 'oxy-e2e-remote-'));
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', remote);
  const { app, win } = await launchApp({ project: repo });
  try {
    await waitForTerminal(win);
    await win.getByTestId('changes-publish').click({ timeout: 10_000 });
    await expect(win.getByTestId('changes-push')).toBeVisible({ timeout: 15_000 });
    expect(git(remote, 'log', '-1', '--format=%s', 'main').toString().trim()).toBe('init');
  } finally {
    await app.close();
  }
});

test('the review shows every change, takes comments and sends them to an agent', async () => {
  const repo = await repoWithIdentity();
  await writeFile(join(repo, 'b.ts'), 'export const b = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'b');
  const claudeDir = await mkdtemp(join(tmpdir(), 'oxy-e2e-claude-'));
  const { app, win } = await launchApp({ project: repo, env: { CLAUDE_CONFIG_DIR: claudeDir } });
  try {
    const id = await waitForTerminal(win);
    await win.locator(`[data-terminal-id="${id}"] .xterm`).click();
    await run(win, `node "${fakeClaude}"`);
    await expect.poll(() => oxyTest(win).text(id)).toContain('fake-claude>');
    await expect(win.getByTestId('terminal-kind-badge')).toHaveText('AI AGENT', { timeout: 10_000 });

    await writeFile(join(repo, 'tracked.txt'), 'one\nchanged by the agent\n');
    await writeFile(join(repo, 'b.ts'), 'export const b = 2;\n');
    await expect(row(win, 'b.ts')).toBeVisible({ timeout: 10_000 });

    await win.getByTestId('section-header-changes').hover();
    await win.getByTestId('changes-review').click();
    const panel = win.getByTestId('review-panel');
    await expect(panel.getByTestId('review-file')).toHaveCount(2);
    await expect(panel.getByTestId('review-progress')).toContainText('0/2 viewed');

    // A comment on a line of the first file's diff.
    const first = panel.locator('[data-testid="review-file"][data-path="b.ts"]');
    const line = first
      .locator('.modified-in-monaco-diff-editor .view-lines:not(.line-delete) .view-line')
      .filter({ hasText: 'export const b = 2;' });
    await expect(line).toBeVisible({ timeout: 15_000 });
    await line.click();
    await win.keyboard.press('Home');
    await win.keyboard.press('Shift+End');
    // Each side of the diff has its toolbar; only the one next to the selection shows.
    const comment = first.locator('[data-testid="selection-add-comment"]:visible');
    await expect(comment).toBeVisible();
    await comment.click();
    await win.getByTestId('review-comment-input').fill('Use a named constant here.');
    await win.getByTestId('review-comment-save').click();
    await expect(panel.getByTestId('review-comment')).toHaveCount(1);
    await expect(panel.getByTestId('review-comment')).toContainText('Use a named constant here.');

    // Viewed files collapse and count.
    await first.getByTestId('review-viewed').check();
    await expect(panel.getByTestId('review-progress')).toContainText('1/2 viewed');

    // Send the review: the prompt carries the comment and goes to the running agent.
    await panel.getByTestId('review-send').click();
    const dialog = win.getByTestId('ask-agent-dialog');
    await expect(dialog.getByTestId('ask-agent-input')).toHaveValue(/Use a named constant here\./);
    await expect(dialog.getByTestId('ask-agent-target')).toBeVisible();
    await dialog.getByTestId('ask-agent-send').click();
    await expect.poll(() => oxyTest(win).text(id), { timeout: 10_000 }).toContain('Please address this review comment');
    await expect(panel.getByTestId('review-comment')).toHaveCount(0);

    // Ask an agent about a file's changes from the CHANGES context menu: copy instead of sending.
    await row(win, 'tracked.txt').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Ask Agent About Changes…' }).click();
    await expect(dialog.getByTestId('ask-agent-contexts')).toContainText('tracked.txt');
    await dialog.getByTestId('ask-agent-preset-explain').click();
    await expect(dialog.getByTestId('ask-agent-input')).toHaveValue(/Explain what these changes do/);
    await dialog.getByTestId('ask-agent-copy').click();
    await expect(dialog).toHaveCount(0);
    const clipboard = (await win.evaluate(() => window.oxy.invoke('clipboard:read'))) as { text: string };
    expect(clipboard.text).toContain('git diff HEAD -- tracked.txt');
  } finally {
    await app.close();
  }
});

test('a diff can be edited and saved, single changes reverted', async () => {
  const repo = await repoWithIdentity();
  await writeFile(join(repo, 'tracked.txt'), 'one\nadded line\n');
  const { app, win } = await launchApp({ project: repo });
  try {
    await waitForTerminal(win);
    await row(win, 'tracked.txt').click();
    const panel = win.locator('[data-testid="diff-panel"][data-path="tracked.txt"]');
    const line = panel
      .locator('.modified-in-monaco-diff-editor .view-lines:not(.line-delete) .view-line')
      .filter({ hasText: 'added line' });
    await expect(line).toBeVisible({ timeout: 15_000 });
    await line.click();
    await win.keyboard.press('End');
    await win.keyboard.type(' (edited)');
    await expect(panel.getByTestId('diff-dirty')).toBeVisible();
    await win.keyboard.press('Control+s');
    await expect(panel.getByTestId('diff-dirty')).toHaveCount(0);
    expect(await readFile(join(repo, 'tracked.txt'), 'utf8')).toBe('one\nadded line (edited)\n');
  } finally {
    await app.close();
  }
});
