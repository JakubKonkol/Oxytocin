import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeProvisionFs } from './node-fs';
import { signOutMainAccount, type SignOutDeps } from './sign-out';

let home: string;
const deps = (patch: Partial<SignOutDeps> = {}): SignOutDeps => ({
  platform: 'linux',
  env: {},
  home,
  fs: nodeProvisionFs,
  ...patch,
});
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'oxy-sign-out-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('signOutMainAccount', () => {
  it('Claude Code: removes the credentials and the signed-in account, nothing else', async () => {
    await mkdir(join(home, '.claude', 'skills'), { recursive: true });
    await writeFile(join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{}}');
    await writeFile(join(home, '.claude', 'settings.json'), '{"theme":"dark"}');
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'x@y.z' }, projects: { '/p': { allowedTools: [] } } }),
    );
    const keychain: string[] = [];
    const removed = await signOutMainAccount(
      'claude',
      deps({ platform: 'darwin', deleteKeychainEntry: (s) => Promise.resolve(void keychain.push(s)) }),
    );
    expect(removed).toEqual([
      join(home, '.claude.json'),
      join(home, '.claude', '.credentials.json'),
      'Keychain: Claude Code-credentials',
    ]);
    expect(JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'))).toEqual({
      projects: { '/p': { allowedTools: [] } },
    });
    expect(await exists(join(home, '.claude', '.credentials.json'))).toBe(false);
    expect(await readFile(join(home, '.claude', 'settings.json'), 'utf8')).toBe('{"theme":"dark"}');
    expect(await exists(join(home, '.claude', 'skills'))).toBe(true);
    expect(keychain).toEqual(['Claude Code-credentials']);
    // Signed out already: nothing to do.
    await expect(signOutMainAccount('claude', deps())).rejects.toThrow(/No sign-in/);
  });

  it('Claude Code with CLAUDE_CONFIG_DIR: the sign-in in that folder; a linked .claude.json stays a link', async () => {
    const dir = join(home, 'cfg');
    await mkdir(dir, { recursive: true });
    await writeFile(join(home, 'dotfiles.json'), JSON.stringify({ oauthAccount: { emailAddress: 'x@y.z' }, a: 1 }));
    await symlink(join(home, 'dotfiles.json'), join(dir, '.claude.json'));
    await signOutMainAccount('claude', deps({ env: { CLAUDE_CONFIG_DIR: dir } }));
    expect(JSON.parse(await readFile(join(home, 'dotfiles.json'), 'utf8'))).toEqual({ a: 1 });
  });

  it('Codex CLI: removes auth.json and keeps config.toml, AGENTS.md and the sessions', async () => {
    const codex = join(home, '.codex');
    await mkdir(join(codex, 'sessions'), { recursive: true });
    await writeFile(join(codex, 'auth.json'), '{"tokens":{}}');
    await writeFile(join(codex, 'config.toml'), 'model = "x"');
    expect(await signOutMainAccount('codex', deps())).toEqual([join(codex, 'auth.json')]);
    expect(await exists(join(codex, 'auth.json'))).toBe(false);
    expect(await readFile(join(codex, 'config.toml'), 'utf8')).toBe('model = "x"');
    expect(await exists(join(codex, 'sessions'))).toBe(true);
  });

  it('Gemini CLI: removes the OAuth credentials and the active Google account', async () => {
    const gemini = join(home, '.gemini');
    await mkdir(gemini, { recursive: true });
    await writeFile(join(gemini, 'oauth_creds.json'), '{}');
    await writeFile(join(gemini, 'google_accounts.json'), JSON.stringify({ active: 'me@gmail.com', old: ['a@b.c'] }));
    await signOutMainAccount('gemini', deps());
    expect(await exists(join(gemini, 'oauth_creds.json'))).toBe(false);
    expect(JSON.parse(await readFile(join(gemini, 'google_accounts.json'), 'utf8'))).toEqual({
      active: null,
      old: ['a@b.c', 'me@gmail.com'],
    });
  });
});
