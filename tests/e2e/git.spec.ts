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
