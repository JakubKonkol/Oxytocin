import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import type { EnsembleRecord } from '../../../src/shared/domain/ensemble';
import { repoRoot } from './launch';
import { freePort } from './mcp';

export const fakeEnsembleClaude = join(
  repoRoot,
  'tests/fixtures/agents/node_modules/@anthropic-ai/claude-code/ensemble.js',
);

/** A git repository with one commit (a project for Ensemble). */
export async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oxy-e2e-ens-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'E2E');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'commit.gpgsign', 'false');
  await writeFile(join(dir, 'README.md'), '# Reports\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

export const gitIn = (dir: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString('utf8').trim();

/** A Claude config folder with a settings.json whose bytes must stay unchanged (isolation). */
export async function claudeConfigDir(): Promise<{ dir: string; hash: () => Promise<string> }> {
  const dir = await mkdtemp(join(tmpdir(), 'oxy-e2e-ens-claude-'));
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ model: 'haiku', effortLevel: 'low' }, null, 2));
  return {
    dir,
    hash: async () =>
      createHash('sha256')
        .update(await readFile(join(dir, 'settings.json')))
        .digest('hex'),
  };
}

/** Points Ensemble at the fake Claude Code and the MCP server at a free port. */
export async function useFakeClaude(win: Page): Promise<void> {
  const port = await freePort();
  await win.evaluate(
    ([command, p]) =>
      window.oxy.invoke('settings:update', {
        'ensemble.commands': { 'claude-code': command },
        'mcp.port': p,
      }),
    [`node "${fakeEnsembleClaude}"`, port] as const,
  );
}

export async function readLog(
  file: string,
): Promise<{ agent: string; event: string; args?: string[]; text?: string; tool?: string; cwd?: string }[]> {
  const text = await readFile(file, 'utf8').catch(() => '');
  return (
    text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { agent: string; event: string; text?: string })
      // On Windows messages are typed as one line ("↵" for line breaks): compare them as lines.
      .map((e) => (e.text ? { ...e, text: e.text.replace(/ ?↵ ?/g, '\n') } : e))
  );
}

export const ensembleRecords = (win: Page) =>
  win.evaluate(() => window.oxy.invoke('ensemble:list', {})) as Promise<EnsembleRecord[]>;

export async function waitForStatus(
  win: Page,
  taskId: string,
  status: string,
  timeout = 60_000,
): Promise<EnsembleRecord> {
  await expect
    .poll(async () => (await ensembleRecords(win)).find((r) => r.task.id === taskId)?.run.status, { timeout })
    .toBe(status);
  return (await ensembleRecords(win)).find((r) => r.task.id === taskId)!;
}
