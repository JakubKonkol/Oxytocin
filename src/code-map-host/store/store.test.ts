import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CODE_MAP_LIMITS,
  CodeMapGraphSchema,
  CodeMapManifestSchema,
  emptyCodeMapCoverage,
} from '@shared/domain/code-map';
import { ensureOxyIgnored, removeOxyEntry, updateProjectGitignore } from './gitignore';
import { OwnerLock } from './owner-lock';
import { deleteMapData, prepareOxyDirectory } from './oxy-dir';
import { safeDirectory } from './paths';
import { atomicWrite, CacheStore, cleanTemporaryFiles, dataSize, loadSnapshot, publishSnapshot } from './writer';

const roots: string[] = [];
const leases: OwnerLock[] = [];
async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oxy-map-store-'));
  roots.push(root);
  return root;
}
async function git(root: string): Promise<void> {
  await promisify(execFile)('git', ['--no-optional-locks', 'init', root], { windowsHide: true });
}
async function acquire(directory: string, options: Parameters<typeof OwnerLock.acquire>[2] = {}) {
  const result = await OwnerLock.acquire(directory, 'Oxytocin test', options);
  if (result.lease) leases.push(result.lease);
  return result;
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const lease of leases.splice(0)) await lease.dispose();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Code Map .gitignore', () => {
  it.each(['.oxy', '.oxy/', '/.oxy', '/.oxy/', '  /.oxy/  ', '\ufeff.oxy/'])('does not duplicate %s', (entry) => {
    expect(ensureOxyIgnored(`${entry}\n`)).toBeNull();
  });
  it.each(['', 'dist', 'dist\n', '\ufeffdist\r\n'])('preserves existing bytes and line endings: %j', (original) => {
    const result = ensureOxyIgnored(original)!;
    expect(result.startsWith(original)).toBe(true);
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    expect(result).toContain(`# Oxytocin local data (Code Map)${eol}/.oxy/${eol}`);
    expect(removeOxyEntry(result)).toBe(original && !original.endsWith('\n') ? `${original}${eol}` : original);
  });
  it('only removes the exact adjacent block, preserving user-owned or edited entries', () => {
    expect(removeOxyEntry('# Oxytocin local data (Code Map)\n/.oxy/\n')).toBe('');
    expect(removeOxyEntry('\ufeff# Oxytocin local data (Code Map)\r\n/.oxy/\r\n')).toBe('\ufeff');
    for (const text of [
      '/.oxy/\n',
      '# Oxytocin local data (Code Map) edited\n/.oxy/\n',
      '# Oxytocin local data (Code Map)\n# note\n/.oxy/\n',
    ])
      expect(removeOxyEntry(text)).toBeNull();
  });
  it('edits a project subfolder, honors opt-out and worktree mode, and can re-enable', async () => {
    const root = await temporary();
    await git(root);
    const sub = join(root, 'package');
    await mkdir(sub);
    const options = {
      root: sub,
      mode: 'project' as const,
      gitPath: 'git',
      ignoreInGit: true,
      removeGitignoreEntry: false,
    };
    await updateProjectGitignore(options);
    await expect(lstat(join(root, '.gitignore'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(sub, '.gitignore'), 'utf8')).toContain('/.oxy/');
    await updateProjectGitignore({ ...options, ignoreInGit: false, removeGitignoreEntry: true });
    expect(await readFile(join(sub, '.gitignore'), 'utf8')).toBe('');
    await updateProjectGitignore({ ...options, ignoreInGit: false });
    expect(await readFile(join(sub, '.gitignore'), 'utf8')).toBe('');
    await updateProjectGitignore({ ...options, mode: 'worktree' });
    expect(await readFile(join(sub, '.gitignore'), 'utf8')).toBe('');
    await updateProjectGitignore(options);
    expect(await readFile(join(sub, '.gitignore'), 'utf8')).toContain('/.oxy/');
  });
  it('does not create a root ignore in a non-Git folder', async () => {
    const root = await temporary();
    await updateProjectGitignore({
      root,
      mode: 'project',
      gitPath: 'git',
      ignoreInGit: true,
      removeGitignoreEntry: false,
    });
    await expect(lstat(join(root, '.gitignore'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.skipIf(process.platform === 'win32')('refuses linked and unwritable root ignores', async () => {
    const root = await temporary();
    await git(root);
    const outside = await temporary();
    const target = join(outside, 'ignore');
    await writeFile(target, 'secret\n');
    await symlink(target, join(root, '.gitignore'));
    const options = { root, mode: 'project' as const, gitPath: 'git', ignoreInGit: true, removeGitignoreEntry: false };
    await expect(updateProjectGitignore(options)).rejects.toThrow('symbolic link');
    await rm(join(root, '.gitignore'));
    await writeFile(join(root, '.gitignore'), 'dist\n');
    await chmod(join(root, '.gitignore'), 0o444);
    await expect(updateProjectGitignore(options)).rejects.toThrow('not writable');
    await chmod(join(root, '.gitignore'), 0o644);
    expect(await readFile(target, 'utf8')).toBe('secret\n');
  });
});

describe('Code Map storage ownership', () => {
  it('refuses deletion while a different instance owns the map', async () => {
    const root = await temporary();
    const directory = await safeDirectory(root, ['.oxy', 'code-map']);
    await acquire(directory);
    await atomicWrite(join(directory, 'MAP.md'), 'last good map');
    await expect(deleteMapData(root)).rejects.toThrow('another Oxytocin');
    expect(await readFile(join(directory, 'MAP.md'), 'utf8')).toBe('last good map');
  });
  it('reports an unwritable root ignore while retaining ownership and .oxy protection', async () => {
    const root = await temporary();
    await git(root);
    const path = join(root, '.gitignore');
    await writeFile(path, 'dist\n');
    await chmod(path, 0o444);
    try {
      const prepared = await prepareOxyDirectory({
        root,
        mode: 'project',
        ignoreInGit: true,
        gitPath: 'git',
        removeGitignoreEntry: false,
        app: 'Oxytocin test',
      });
      leases.push(prepared.lease!);
      expect(prepared.warning).toContain('not writable');
      expect(prepared.lease).not.toBeNull();
      expect(await readFile(join(root, '.oxy/.gitignore'), 'utf8')).toBe('*\n');
    } finally {
      await chmod(path, 0o644);
    }
  });
  it('admits one writer under concurrent claims and updates the heartbeat', async () => {
    const directory = await temporary();
    const claims = await Promise.all(Array.from({ length: 8 }, () => acquire(directory)));
    expect(claims.filter((claim) => claim.lease)).toHaveLength(1);
    const lease = claims.find((claim) => claim.lease)!.lease!;
    await lease.heartbeat();
    await expect(lease.assertOwned()).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(join(directory, 'owner.lock'), 'utf8'))).toMatchObject({
      instanceId: lease.instanceId,
      pid: process.pid,
    });
  });
  it.each(['expired', 'dead'] as const)(
    'takes over an %s owner, but the old owner cannot remove the new lock',
    async (reason) => {
      const directory = await temporary();
      const first = (await acquire(directory)).lease!;
      if (reason === 'expired') {
        const owner = JSON.parse(await readFile(join(directory, 'owner.lock'), 'utf8')) as Record<string, unknown>;
        owner['heartbeatAt'] = new Date(Date.now() - 121_000).toISOString();
        await writeFile(join(directory, 'owner.lock'), JSON.stringify(owner));
      }
      const second = (await acquire(directory, { alive: () => reason !== 'dead' })).lease!;
      expect(second).not.toBeNull();
      await expect(first.assertOwned()).rejects.toThrow('another Oxytocin');
      await first.dispose();
      await expect(second.assertOwned()).resolves.toBeUndefined();
    },
  );
  it('refuses an external .oxy junction without writing through it', async () => {
    const root = await temporary();
    const outside = await temporary();
    await symlink(outside, join(root, '.oxy'), 'junction');
    await expect(safeDirectory(root, ['.oxy', 'code-map'])).rejects.toThrow('escapes');
    await expect(lstat(join(outside, 'code-map'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps learnings when deleting map data and removes an otherwise empty .oxy', async () => {
    const root = await temporary();
    await safeDirectory(root, ['.oxy', 'code-map']);
    await safeDirectory(root, ['.oxy', 'learnings']);
    await writeFile(join(root, '.oxy/learnings/learnings.json'), 'kept');
    await deleteMapData(root);
    expect(await readFile(join(root, '.oxy/learnings/learnings.json'), 'utf8')).toBe('kept');
    const empty = await temporary();
    await safeDirectory(empty, ['.oxy', 'code-map']);
    await writeFile(join(empty, '.oxy/README.md'), 'generated');
    await deleteMapData(empty);
    await expect(lstat(join(empty, '.oxy'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('creates .oxy protection in worktrees even when root Git protection is opted out', async () => {
    const root = await temporary();
    await git(root);
    const prepared = await prepareOxyDirectory({
      root,
      mode: 'worktree',
      ignoreInGit: false,
      gitPath: 'git',
      removeGitignoreEntry: false,
      app: 'Oxytocin test',
    });
    leases.push(prepared.lease!);
    expect(await readFile(join(root, '.oxy/.gitignore'), 'utf8')).toBe('*\n');
    await expect(lstat(join(root, '.gitignore'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('Code Map publication', () => {
  function snapshot() {
    const graph = CodeMapGraphSchema.parse({
      format: 'oxytocin.code-map',
      schemaVersion: 1,
      generator: { oxytocin: 'test', extractors: {}, grammars: {}, settingsHash: `sha256:${'0'.repeat(64)}` },
      groups: [],
      files: [],
      packages: [],
      symbols: [],
      edges: [],
      unresolved: [],
      coverage: emptyCodeMapCoverage(),
    });
    const time = new Date().toISOString();
    const manifest = CodeMapManifestSchema.parse({
      format: 'oxytocin.code-map.manifest',
      schemaVersion: 1,
      state: 'ready',
      graphSha256: '0'.repeat(64),
      generation: 1,
      builtAt: time,
      lastReconciledAt: time,
      lastFullHashAt: time,
      durationsMs: { enumerate: 0, parse: 0, resolve: 0, write: 0 },
      counts: { files: 0, symbols: 0, edges: 0 },
      limits: CODE_MAP_LIMITS,
      warnings: [],
    });
    return { graph, manifest, map: '# Map\n' };
  }
  it('publishes cache first and manifest last, validates hashes and prunes obsolete cache', async () => {
    const root = await temporary();
    const directory = await safeDirectory(root, ['.oxy', 'code-map']);
    const firstHash = '1'.repeat(64),
      nextHash = '2'.repeat(64);
    await publishSnapshot(root, { ...snapshot(), cache: new Map([[firstHash, '{}']]) }, () => Promise.resolve());
    expect(await loadSnapshot(directory)).not.toBeNull();
    await publishSnapshot(root, { ...snapshot(), cache: new Map([[nextHash, '{}']]) }, () => Promise.resolve());
    await expect(lstat(join(directory, 'cache/11', `${firstHash}.json.gz`))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await dataSize(directory)).toBeGreaterThan(0);
    await writeFile(join(directory, 'graph.json'), '{}');
    expect(await loadSnapshot(directory)).toBeNull();
  });
  it('indexes compressed records once, drops older record formats and reports sizes without walking', async () => {
    const root = await temporary();
    const directory = await safeDirectory(root, ['.oxy', 'code-map']);
    const legacy = '3'.repeat(64);
    await mkdir(join(directory, 'cache/33'), { recursive: true });
    await writeFile(join(directory, 'cache/33', `${legacy}.json`), '{}');
    const store = new CacheStore(root);
    await store.load();
    await expect(lstat(join(directory, 'cache/33', `${legacy}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
    const key = '4'.repeat(64);
    const record = JSON.stringify({ value: 'x'.repeat(10_000) });
    const { bytes } = await publishSnapshot(
      root,
      { ...snapshot(), cache: new Map([[key, record]]) },
      () => Promise.resolve(),
      store,
    );
    expect(store.bytes).toBeLessThan(record.length / 10);
    expect(bytes).toBe(await dataSize(directory));
    expect(await store.read(key)).toBe(record);
    const reloaded = new CacheStore(root);
    await reloaded.load();
    expect(reloaded.bytes).toBe(store.bytes);
    expect(await reloaded.read('5'.repeat(64))).toBeNull();
  });
  it('never truncates the graph when publication is interrupted', async () => {
    const root = await temporary();
    const directory = await safeDirectory(root, ['.oxy', 'code-map']);
    await publishSnapshot(root, snapshot(), () => Promise.resolve());
    const next = snapshot();
    next.graph.generator.oxytocin = 'next';
    let writes = 0;
    await expect(
      publishSnapshot(root, next, () => {
        if (++writes === 3) return Promise.reject(new Error('terminated'));
        return Promise.resolve();
      }),
    ).rejects.toThrow('terminated');
    expect(
      CodeMapGraphSchema.safeParse(JSON.parse(await readFile(join(directory, 'graph.json'), 'utf8'))).success,
    ).toBe(true);
    expect(await loadSnapshot(directory)).toBeNull();
  });
  it('cleans old temporary files only and rejects linked write destinations', async () => {
    const directory = await temporary();
    const old = join(directory, 'old.tmp-1');
    const recent = join(directory, 'recent.tmp-2');
    await atomicWrite(old, 'old');
    await atomicWrite(recent, 'recent');
    await atomicWrite(join(directory, 'graph.json'), 'keep');
    const time = new Date(Date.now() - 3_600_001);
    await utimes(old, time, time);
    await cleanTemporaryFiles(directory);
    await expect(lstat(old)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(recent, 'utf8')).toBe('recent');
    expect(await readFile(join(directory, 'graph.json'), 'utf8')).toBe('keep');
  });
});
