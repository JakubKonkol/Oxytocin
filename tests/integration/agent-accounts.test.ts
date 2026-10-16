import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentAccountSchema } from '../../src/shared/domain/ai-agents';
import { nodeProvisionFs } from '../../src/main/services/ai-agents/accounts/node-fs';
import {
  ensureAccount,
  MARKER_FILE,
  type ProvisionDeps,
  removeAccountFolder,
} from '../../src/main/services/ai-agents/accounts/provisioner';

let home: string;
let deps: ProvisionDeps;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'oxy-accounts-')));
  deps = {
    platform: process.platform,
    env: {},
    home,
    fs: nodeProvisionFs,
    accountsRoot: join(home, '.oxytocin', 'accounts'),
  };
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const account = (agent: 'claude' | 'codex' | 'gemini', slug = 'work', mode: 'shared' | 'isolated' = 'shared') =>
  AgentAccountSchema.parse({
    id: `a-${agent}-${slug}`,
    agent,
    name: slug,
    home: join(home, '.oxytocin', 'accounts', agent, slug),
    createdAt: 1,
    mode,
  });

const isLink = async (p: string) => (await lstat(p)).isSymbolicLink();

// Windows (junctions, refused file links) is covered by the unit tests with a fake file system.
describe.skipIf(process.platform === 'win32')('agent accounts on a real file system', () => {
  it('Claude Code: shares the main setup through links; the sign-in and sessions stay separate', async () => {
    const main = join(home, '.claude');
    await mkdir(join(main, 'skills', 'review'), { recursive: true });
    await writeFile(join(main, 'skills', 'review', 'SKILL.md'), 'review skill');
    await writeFile(join(main, 'CLAUDE.md'), 'global rules');
    await writeFile(join(main, 'settings.json'), '{"model":"opus"}');
    await writeFile(join(main, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"secret"}}');
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'me@x' }, mcpServers: { oxytocin: { type: 'http' } } }),
    );
    const a = account('claude');
    expect(await ensureAccount(a, deps)).toEqual([]);

    expect(await readFile(join(a.home, 'skills', 'review', 'SKILL.md'), 'utf8')).toBe('review skill');
    expect(await isLink(join(a.home, 'skills'))).toBe(true);
    expect(await readlink(join(a.home, 'settings.json'))).toBe(join(main, 'settings.json'));
    expect(await readFile(join(a.home, 'CLAUDE.md'), 'utf8')).toContain('@~/.claude/CLAUDE.md');
    expect(JSON.parse(await readFile(join(a.home, '.claude.json'), 'utf8'))).toEqual({
      mcpServers: { oxytocin: { type: 'http' } },
    });
    await expect(lstat(join(a.home, '.credentials.json'))).rejects.toThrow();
    expect((await lstat(a.home)).mode & 0o777).toBe(0o700);

    // A skill added in the account lands in the main account; settings written through the link are the main ones.
    await mkdir(join(a.home, 'skills', 'new'));
    await writeFile(join(a.home, 'settings.json'), '{"model":"sonnet"}');
    expect(await readFile(join(main, 'settings.json'), 'utf8')).toBe('{"model":"sonnet"}');
    expect((await lstat(join(main, 'skills', 'new'))).isDirectory()).toBe(true);

    // Idempotent; a deleted link is repaired at the next start.
    await rm(join(a.home, 'agents'));
    expect(await ensureAccount(a, deps)).toEqual([]);
    expect(await isLink(join(a.home, 'agents'))).toBe(true);

    // Removing the account deletes its folder only.
    await removeAccountFolder(a, deps);
    await expect(lstat(a.home)).rejects.toThrow();
    expect(await readFile(join(main, 'skills', 'review', 'SKILL.md'), 'utf8')).toBe('review skill');
    expect(await readFile(join(main, 'CLAUDE.md'), 'utf8')).toBe('global rules');
    expect(await readFile(join(main, '.credentials.json'), 'utf8')).toContain('secret');
  });

  it('Codex CLI and Gemini CLI: config and instructions shared, auth separate; isolated shares nothing', async () => {
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n');
    await writeFile(join(home, '.codex', 'auth.json'), '{"tokens":{}}');
    const codex = account('codex');
    expect(await ensureAccount(codex, deps)).toEqual([]);
    expect(await readFile(join(codex.home, 'config.toml'), 'utf8')).toBe('model = "gpt-5"\n');
    await expect(lstat(join(codex.home, 'auth.json'))).rejects.toThrow();

    await mkdir(join(home, '.gemini', 'commands'), { recursive: true });
    await writeFile(join(home, '.gemini', 'GEMINI.md'), 'gemini rules');
    const gemini = account('gemini');
    expect(await ensureAccount(gemini, deps)).toEqual([]);
    expect(await readFile(join(gemini.home, '.gemini', 'GEMINI.md'), 'utf8')).toBe('gemini rules');
    expect(await isLink(join(gemini.home, '.gemini', 'commands'))).toBe(true);

    const isolated = account('claude', 'private', 'isolated');
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', 'settings.json'), '{}');
    expect(await ensureAccount(isolated, deps)).toEqual([]);
    await expect(lstat(join(isolated.home, 'settings.json'))).rejects.toThrow();
    expect(JSON.parse(await readFile(join(isolated.home, MARKER_FILE), 'utf8'))).toMatchObject({ id: isolated.id });
  });
});
