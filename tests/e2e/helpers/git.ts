import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@e', '-c', 'commit.gpgsign=false'];
export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', [...IDENTITY, ...args], { cwd, stdio: 'pipe' });

export async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oxy-e2e-repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  // Byte-exact files on every platform (Windows runners default to core.autocrlf=true).
  git(dir, 'config', 'core.autocrlf', 'false');
  await writeFile(join(dir, 'tracked.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}
