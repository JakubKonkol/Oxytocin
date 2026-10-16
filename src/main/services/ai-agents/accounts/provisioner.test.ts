import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type AgentAccount, AgentAccountSchema } from '@shared/domain/ai-agents';
import { claudeKeychainService } from './adapters';
import {
  assertAccountFolder,
  type EntryKind,
  ensureAccount,
  MARKER_FILE,
  type ProvisionDeps,
  type ProvisionFs,
  removeAccountFolder,
} from './provisioner';

type Node = { kind: 'file'; text: string } | { kind: 'dir' } | { kind: 'link'; target: string };

/** An in-memory Windows file system whose file links fail like without Developer Mode. */
function fakeWindowsFs(fileLinks: 'fail' | 'ok' = 'fail') {
  const nodes = new Map<string, Node>();
  const key = (p: string) => win32.resolve(p).toLowerCase();
  const follow = (p: string): string => {
    const n = nodes.get(key(p));
    return n?.kind === 'link' ? follow(n.target) : p;
  };
  const calls: string[] = [];
  const fs: ProvisionFs = {
    kind: (p): Promise<EntryKind> => Promise.resolve(nodes.get(key(p))?.kind ?? 'missing'),
    readlink: (p) => {
      const n = nodes.get(key(p));
      return Promise.resolve(n?.kind === 'link' ? `\\\\?\\${n.target}` : null);
    },
    mkdir: (p) => {
      let dir = win32.resolve(p);
      while (dir !== win32.dirname(dir)) {
        if (!nodes.has(key(dir))) nodes.set(key(dir), { kind: 'dir' });
        dir = win32.dirname(dir);
      }
      return Promise.resolve();
    },
    symlink: (target, p, type) => {
      calls.push(`symlink:${type}:${p}`);
      if (type === 'file' && fileLinks === 'fail')
        return Promise.reject(new Error('EPERM: operation not permitted, symlink'));
      nodes.set(key(p), { kind: 'link', target });
      return Promise.resolve();
    },
    readText: (p) => {
      const n = nodes.get(key(follow(p)));
      return Promise.resolve(n?.kind === 'file' ? n.text : null);
    },
    writeText: (p, text) => {
      nodes.set(key(follow(p)), { kind: 'file', text });
      return Promise.resolve();
    },
    unlink: (p) => {
      calls.push(`unlink:${p}`);
      nodes.delete(key(p));
      return Promise.resolve();
    },
    removeTree: (p) => {
      calls.push(`removeTree:${p}`);
      // Like rm -r: links inside are removed, never followed.
      const prefix = key(p);
      for (const k of [...nodes.keys()]) if (k === prefix || k.startsWith(`${prefix}\\`)) nodes.delete(k);
      return Promise.resolve();
    },
  };
  const file = (p: string, text: string) => {
    void fs.mkdir(win32.dirname(p));
    nodes.set(key(p), { kind: 'file', text });
  };
  const get = (p: string) => nodes.get(key(p));
  return { fs, file, get, calls, dir: (p: string) => fs.mkdir(p) };
}

const HOME = 'C:\\Users\\Jan';
const ROOT = `${HOME}\\.oxytocin\\accounts`;

const account = (patch: Partial<AgentAccount> = {}): AgentAccount =>
  AgentAccountSchema.parse({
    id: 'acc1',
    agent: 'claude',
    name: 'Work',
    home: `${ROOT}\\claude\\work`,
    createdAt: 1,
    ...patch,
  });

function deps(fs: ProvisionFs, env: Record<string, string> = {}): ProvisionDeps {
  return { platform: 'win32', env, home: HOME, fs, accountsRoot: ROOT };
}

describe('ensureAccount (Windows)', () => {
  it('links folders as junctions, imports CLAUDE.md and copies files Windows will not link', async () => {
    const w = fakeWindowsFs();
    const main = `${HOME}\\.claude`;
    await w.dir(`${main}\\skills`);
    w.file(`${main}\\settings.json`, '{"model":"opus"}');
    w.file(`${HOME}\\.claude.json`, JSON.stringify({ oauthAccount: { emailAddress: 'me@x' }, mcpServers: { a: {} } }));
    const notes = await ensureAccount(account(), deps(w.fs));
    expect(notes).toEqual([]);
    const home = `${ROOT}\\claude\\work`;
    expect(w.get(`${home}\\skills`)).toEqual({ kind: 'link', target: `${main}\\skills` });
    expect(w.calls).toContain(`symlink:junction:${home}\\skills`);
    // Missing folders of the main account are created so both accounts use them.
    expect(w.get(`${home}\\agents`)).toEqual({ kind: 'link', target: `${main}\\agents` });
    expect(w.get(`${main}\\agents`)).toEqual({ kind: 'dir' });
    const stub = w.get(`${home}\\CLAUDE.md`);
    expect(stub?.kind === 'file' && stub.text).toContain('\n@~/.claude/CLAUDE.md\n');
    expect(w.get(`${home}\\settings.json`)).toEqual({ kind: 'file', text: '{"model":"opus"}' });
    // Only the MCP servers of .claude.json: never the sign-in.
    const seeded = w.get(`${home}\\.claude.json`);
    expect(seeded?.kind === 'file' && JSON.parse(seeded.text)).toEqual({ mcpServers: { a: {} } });
    // A file missing in the main account cannot be copied yet.
    expect(w.get(`${home}\\plugins\\installed_plugins.json`)).toBeUndefined();
    const marker = w.get(`${home}\\${MARKER_FILE}`);
    const written = marker?.kind === 'file' ? (JSON.parse(marker.text) as { id: string; copies: object }) : null;
    expect(written?.id).toBe('acc1');
    expect(Object.keys(written?.copies ?? {})).toEqual(['settings.json']);
  });

  it('follows the main settings while the copy is unchanged, and reports a copy changed in the account', async () => {
    const w = fakeWindowsFs();
    const main = `${HOME}\\.claude`;
    const home = `${ROOT}\\claude\\work`;
    w.file(`${main}\\settings.json`, 'v1');
    await ensureAccount(account(), deps(w.fs));
    w.file(`${main}\\settings.json`, 'v2');
    expect(await ensureAccount(account(), deps(w.fs))).toEqual([]);
    expect(w.get(`${home}\\settings.json`)).toEqual({ kind: 'file', text: 'v2' });

    w.file(`${home}\\settings.json`, 'mine');
    w.file(`${main}\\settings.json`, 'v3');
    expect(await ensureAccount(account(), deps(w.fs))).toEqual([
      "settings.json was changed in this account, so it no longer follows the main account's file.",
    ]);
    expect(w.get(`${home}\\settings.json`)).toEqual({ kind: 'file', text: 'mine' });
  });

  it('never overwrites what the account already has, and is idempotent', async () => {
    const w = fakeWindowsFs('ok');
    const home = `${ROOT}\\claude\\work`;
    await w.dir(`${HOME}\\.claude`);
    w.file(`${home}\\CLAUDE.md`, 'my own');
    await w.dir(`${home}\\commands`);
    const notes = await ensureAccount(account(), deps(w.fs));
    expect(notes).toEqual(["commands is the account's own: it is not shared with the main account."]);
    expect(w.get(`${home}\\CLAUDE.md`)).toEqual({ kind: 'file', text: 'my own' });
    // File links work with Developer Mode; a link to the main account is recognized again (\\?\ prefix, any case).
    expect(w.get(`${home}\\settings.json`)).toEqual({ kind: 'link', target: `${HOME}\\.claude\\settings.json` });
    const before = w.calls.length;
    expect(await ensureAccount(account(), deps(w.fs))).toHaveLength(1);
    expect(w.calls.length).toBe(before);
  });

  it('shares nothing in the isolated setup', async () => {
    const w = fakeWindowsFs();
    w.file(`${HOME}\\.claude\\settings.json`, 'x');
    await ensureAccount(account({ mode: 'isolated' }), deps(w.fs));
    expect(w.calls).toEqual([]);
    expect(w.get(`${ROOT}\\claude\\work\\settings.json`)).toBeUndefined();
    expect(w.get(`${ROOT}\\claude\\work\\${MARKER_FILE}`)?.kind).toBe('file');
  });

  it("follows the main account of the user's own variables; Gemini keeps its files in .gemini", async () => {
    const w = fakeWindowsFs();
    w.file(
      'D:\\gem\\.gemini\\settings.json',
      JSON.stringify({
        selectedAuthType: 'oauth-personal',
        theme: 'x',
        security: { auth: { selectedType: 'a' }, other: 1 },
      }),
    );
    w.file('D:\\gem\\.gemini\\GEMINI.md', 'hi');
    const home = `${ROOT}\\gemini\\work`;
    await ensureAccount(account({ agent: 'gemini', home }), deps(w.fs, { gemini_cli_home: 'D:\\gem' }));
    expect(w.get(`${home}\\.gemini\\GEMINI.md`)).toEqual({ kind: 'file', text: 'hi' });
    expect(w.get(`${home}\\.gemini\\extensions`)).toEqual({ kind: 'link', target: 'D:\\gem\\.gemini\\extensions' });
    const settings = w.get(`${home}\\.gemini\\settings.json`);
    expect(settings?.kind === 'file' && JSON.parse(settings.text)).toEqual({ theme: 'x', security: { other: 1 } });
  });

  it('refuses folders outside the accounts root', async () => {
    const w = fakeWindowsFs();
    await expect(ensureAccount(account({ home: `${HOME}\\.claude` }), deps(w.fs))).rejects.toThrow(
      /Not an account folder/,
    );
    expect(() => assertAccountFolder(deps(w.fs), `${ROOT}\\claude`)).toThrow();
    expect(() => assertAccountFolder(deps(w.fs), `${ROOT}\\claude\\work\\..\\..\\x`)).toThrow();
    expect(() => assertAccountFolder(deps(w.fs), `${ROOT}\\claude\\work`)).not.toThrow();
  });
});

describe('removeAccountFolder', () => {
  it('unlinks the shared items before deleting the folder, so the main account stays', async () => {
    const w = fakeWindowsFs();
    await w.dir(`${HOME}\\.claude\\skills`);
    w.file(`${HOME}\\.claude\\skills\\s.md`, 'skill');
    await ensureAccount(account(), deps(w.fs));
    await removeAccountFolder(account(), deps(w.fs));
    expect(w.calls.filter((c) => c.startsWith('unlink:') || c.startsWith('removeTree:'))[0]).toMatch(/^unlink:/);
    expect(w.get(`${ROOT}\\claude\\work`)).toBeUndefined();
    expect(w.get(`${HOME}\\.claude\\skills\\s.md`)).toEqual({ kind: 'file', text: 'skill' });
  });

  it('removes the Claude Code Keychain entry on macOS', async () => {
    const removed: string[] = [];
    const home = '/Users/jan/.oxytocin/accounts/claude/work';
    const fs = fakeWindowsFs().fs;
    await removeAccountFolder(account({ home }), {
      platform: 'darwin',
      env: {},
      home: '/Users/jan',
      fs,
      accountsRoot: '/Users/jan/.oxytocin/accounts',
      deleteKeychainEntry: (s) => {
        removed.push(s);
        return Promise.resolve();
      },
    });
    expect(removed).toEqual([claudeKeychainService(home)]);
    expect(claudeKeychainService(home)).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
  });
});
