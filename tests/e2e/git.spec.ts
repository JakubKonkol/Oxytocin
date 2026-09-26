import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { activeProjectId, nodeCmd, run, waitForTerminal } from './helpers/terminal';

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@e', '-c', 'commit.gpgsign=false'];
const git = (cwd: string, ...args: string[]) => execFileSync('git', [...IDENTITY, ...args], { cwd, stdio: 'pipe' });

export async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oxy-e2e-repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  await writeFile(join(dir, 'tracked.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

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
