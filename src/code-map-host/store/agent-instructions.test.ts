import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { editAgentInstructions } from './agent-instructions';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), 'oxy-instructions-'));
  roots.push(root);
  return root;
}
it('writes only explicit instruction files, preserves bytes and removes a newly created empty file', async () => {
  const root = await temporary(),
    original = '\ufeff# Rules\r\n';
  await writeFile(join(root, 'CLAUDE.md'), original);
  expect(await editAgentInstructions(root, 'CLAUDE.md', 'add')).toEqual({ changed: true });
  expect(await editAgentInstructions(root, 'CLAUDE.md', 'add')).toEqual({ changed: false });
  expect(await editAgentInstructions(root, 'CLAUDE.md', 'remove')).toEqual({ changed: true });
  expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe(original);
  await editAgentInstructions(root, 'AGENTS.md', 'add');
  await editAgentInstructions(root, 'AGENTS.md', 'remove');
  await expect(readFile(join(root, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('refuses a file that is not UTF-8 instead of rewriting its bytes', async () => {
  const root = await temporary(),
    latin1 = Buffer.from('# R\xe8gles\n', 'latin1');
  await writeFile(join(root, 'CLAUDE.md'), latin1);
  await expect(editAgentInstructions(root, 'CLAUDE.md', 'add')).rejects.toThrow('UTF-8');
  expect(await readFile(join(root, 'CLAUDE.md'))).toEqual(latin1);
});
it.skipIf(process.platform === 'win32')('keeps the permissions of an edited file', async () => {
  const root = await temporary();
  await writeFile(join(root, 'CLAUDE.md'), '# Rules\n');
  await chmod(join(root, 'CLAUDE.md'), 0o664);
  await editAgentInstructions(root, 'CLAUDE.md', 'add');
  expect((await stat(join(root, 'CLAUDE.md'))).mode & 0o777).toBe(0o664);
  await editAgentInstructions(root, 'AGENTS.md', 'add');
  expect((await stat(join(root, 'AGENTS.md'))).mode & 0o777).toBe(0o644);
});
it.skipIf(process.platform === 'win32')(
  'refuses an escaping instruction symlink without touching its target',
  async () => {
    const root = await temporary(),
      outside = await temporary(),
      target = join(outside, 'rules.md');
    await writeFile(target, 'outside');
    await symlink(target, join(root, 'CLAUDE.md'));
    await expect(editAgentInstructions(root, 'CLAUDE.md', 'add')).rejects.toThrow('symbolic link');
    expect(await readFile(target, 'utf8')).toBe('outside');
  },
);
