import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { git, makeRepo } from './helpers/git';
import { launchApp } from './helpers/launch';
import { activeProjectId, nodeCmd, oxyTest, run, waitForTerminal } from './helpers/terminal';

interface Status {
  state: string;
  files: { path: string; status: string; additions?: number }[];
}

test('git status follows files written in a terminal', async () => {
  const repo = await makeRepo();
  const { app, win } = await launchApp({ project: repo });
  try {
    await waitForTerminal(win);
    const projectId = await activeProjectId(win);
    const status = () =>
      win.evaluate((id) => window.oxy.invoke('git:getStatus', { projectId: id }), projectId) as Promise<Status | null>;
    await expect.poll(async () => (await status())?.state, { timeout: 10_000 }).toBe('ok');
    expect((await status())!.files).toEqual([]);

    await run(win, nodeCmd("require('fs').writeFileSync('new.txt', 'a\\nb\\n')"));
    await expect
      .poll(async () => (await status())?.files.map((f) => `${f.status}:${f.path}:${f.additions}`), { timeout: 5_000 })
      .toEqual(['untracked:new.txt:2']);
  } finally {
    await app.close();
  }
});

test('the CHANGES section shows new, modified and committed files live', async () => {
  const repo = await makeRepo();
  const { app, win } = await launchApp({ project: repo });
  try {
    await waitForTerminal(win);
    const section = win.getByTestId('changes-section');
    await expect(section.getByText('No changes since HEAD ✓')).toBeVisible({ timeout: 10_000 });
    await expect(section.getByTestId('changes-branch')).toHaveText('main');

    const row = (path: string) => section.locator(`[data-testid="changes-row"][data-path="${path}"]`);
    const start = Date.now();
    await run(win, nodeCmd("require('fs').writeFileSync('a.txt', 'x\\n')"));
    await expect(row('a.txt')).toBeVisible({ timeout: 5_000 });
    const shownAfter = Date.now() - start;
    await expect(row('a.txt').getByTestId('changes-status-letter')).toHaveText('U');
    console.log(`untracked file visible after ${shownAfter} ms (incl. typing the command)`);

    await run(win, nodeCmd("require('fs').appendFileSync('tracked.txt', 'two\\nthree\\n')"));
    await expect(row('tracked.txt').getByTestId('changes-status-letter')).toHaveText('M');
    await expect(row('tracked.txt')).toContainText('+2');
    await expect(section.getByTestId('changes-totals')).toContainText('2 files');
    await expect(win.getByTestId('status-git')).toContainText('2 changes');

    await run(win, 'git add -A');
    await run(win, 'git -c user.name=t -c user.email=t@e -c commit.gpgsign=false commit -qm done');
    await expect(section.getByText('No changes since HEAD ✓')).toBeVisible({ timeout: 5_000 });
    await expect(section.getByText(/Last commit .*: done/)).toBeVisible();
  } finally {
    await app.close();
  }
});

test('clicking a change opens its diff (preview tab), live updates and pins on double-click', async () => {
  const repo = await makeRepo();
  await writeFile(join(repo, 'crlf.txt'), 'a\r\nb\r\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'crlf');
  const { app, win } = await launchApp({ project: repo });
  const errors: string[] = [];
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  try {
    await waitForTerminal(win);
    const t = oxyTest(win);
    await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n');
    await writeFile(join(repo, 'crlf.txt'), 'a\r\nB\r\n');
    const section = win.getByTestId('changes-section');
    const row = (path: string) => section.locator(`[data-testid="changes-row"][data-path="${path}"]`);
    await row('tracked.txt').click();

    const panel = win.locator('[data-testid="diff-panel"][data-path="tracked.txt"]');
    await expect(panel).toBeVisible();
    const panelId = () => t.workspace().then((ws) => ws?.panels.find((p) => p.id.startsWith('diff-'))?.id ?? '');
    await expect.poll(async () => (await t.diff(await panelId()))?.modified, { timeout: 15_000 }).toBe('one\ntwo\n');
    expect((await t.diff(await panelId()))?.original).toBe('one\n');
    await expect.poll(async () => (await t.diff(await panelId()))?.changes).toBe(1);
    await expect(win.getByTestId('tab-title').filter({ hasText: 'tracked.txt' })).toHaveAttribute(
      'data-preview',
      'true',
    );

    // The preview tab is reused for the next file; CRLF files show only the real change.
    await row('crlf.txt').click();
    await expect(win.locator('[data-testid="diff-panel"][data-path="crlf.txt"]')).toBeVisible();
    await expect.poll(async () => (await t.diff(await panelId()))?.modified).toBe('a\r\nB\r\n');
    expect((await t.diff(await panelId()))?.original).toBe('a\r\nb\r\n');
    await expect.poll(async () => (await t.diff(await panelId()))?.changes).toBe(1);
    expect((await t.workspace())?.panels.filter((p) => p.id.startsWith('diff-'))).toHaveLength(1);

    // Live update while open.
    await writeFile(join(repo, 'crlf.txt'), 'a\r\nB\r\nc\r\n');
    await expect
      .poll(async () => (await t.diff(await panelId()))?.modified, { timeout: 5_000 })
      .toBe('a\r\nB\r\nc\r\n');
    await expect(win.getByTestId('diff-updated')).toBeVisible();

    // Double-click pins; the next click opens a second (preview) panel.
    await row('crlf.txt').dblclick();
    await expect(win.getByTestId('tab-title').filter({ hasText: 'crlf.txt' })).toHaveAttribute('data-preview', 'false');
    await row('tracked.txt').click();
    await expect.poll(async () => (await t.workspace())?.panels.filter((p) => p.id.startsWith('diff-')).length).toBe(2);

    expect(errors.filter((e) => /Content Security Policy|worker/i.test(e))).toEqual([]);
  } finally {
    await app.close();
  }
});

test('"Open in editor" with the terminal preset runs the editor command in a new terminal panel', async () => {
  const repo = await makeRepo();
  await writeFile(join(repo, 'show.js'), "console.log('EDITOR-OPENED ' + process.argv[2] + ':' + process.argv[3]);\n");
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({ 'editor.preset': 'terminal', 'editor.command': 'node show.js ${file} ${line}' }),
  );
  const { app, win } = await launchApp({ userData, project: repo });
  try {
    await waitForTerminal(win);
    await writeFile(join(repo, 'tracked.txt'), 'changed\n');
    const row = win.locator('[data-testid="changes-row"][data-path="tracked.txt"]');
    await expect(row).toBeVisible();
    await row.click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Open in editor' }).click();
    await expect.poll(async () => (await oxyTest(win).workspace())?.panels.length).toBe(2);
    const editorTerminal = (await oxyTest(win).workspace())!.panels.find((p) => p.terminalId)!;
    const ids = (await oxyTest(win).workspace())!.panels.map((p) => p.terminalId).filter(Boolean) as string[];
    await expect
      .poll(async () => (await Promise.all(ids.map((id) => oxyTest(win).text(id)))).join('\n'), { timeout: 10_000 })
      .toMatch(/EDITOR-OPENED .*tracked\.txt:1/);
    expect(editorTerminal).toBeTruthy();
    await expect(win.getByTestId('tab-title').filter({ hasText: 'Editor' })).toBeVisible();
  } finally {
    await app.close();
  }
});
