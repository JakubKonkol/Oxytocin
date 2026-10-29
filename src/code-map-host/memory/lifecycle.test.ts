import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { MemoryAuthority } from '@shared/domain/code-map-memory';
import { LearningDraftSchema } from '@shared/domain/code-map-memory';
import { LearningMemory } from './admission';
import { emptyMemory, listArchives, loadMemory, writeMemory } from './store';
import { reserveMemory } from './locations';
import { OwnerLock } from '../store/owner-lock';
import { safeDirectory } from '../store/paths';
import type { WatchSubscribe } from '../watch';
import * as writer from '../store/writer';
import { evidenceFor } from './applicability';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'oxy-learning-lifecycle-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'rules.md'), 'Original evidence.\n');
  const events = new Map<string, Parameters<WatchSubscribe>[1]>();
  const subscribe: WatchSubscribe = (path, callback) => {
    events.set(path, callback);
    return Promise.resolve({
      unsubscribe: () => {
        events.delete(path);
        return Promise.resolve();
      },
    });
  };
  const memory = new LearningMemory(() => undefined, subscribe);
  cleanup.push(() => memory.dispose());
  const authority: MemoryAuthority = {
    projectId: 'p',
    checkoutId: 'p',
    root,
    projectRoot: root,
    checkouts: [{ checkoutId: 'p', root }],
    excludedPaths: [],
    origin: { source: 'user' },
  };
  const save = {
    action: 'save' as const,
    draft: LearningDraftSchema.parse({
      kind: 'constraint',
      title: 'Protocol',
      body: 'Use the protocol.',
      topic: 'protocol',
      evidence: [{ path: 'rules.md' }],
    }),
    expectedRevision: 0,
    idempotencyKey: 'save',
  };
  const first = (await memory.run(authority, save)).records[0]!;
  const accepted = (
    await memory.run(authority, {
      action: 'review',
      id: first.id,
      expectedRevision: first.revision,
      idempotencyKey: 'accept',
      decision: 'accept',
    })
  ).records[0]!;
  return { root, authority, memory, save, accepted, events, subscribe };
}
it('latches raw watcher events before rebuilds and after edit/revert between reads', async () => {
  const { root, authority, memory, accepted, events } = await fixture();
  events.get(root)!(null, [{ path: join(root, 'rules.md'), type: 'update' }]);
  // Disk bytes are already back to their original value. The watcher still invalidates applicability.
  const record = (await memory.run(authority, { action: 'get', id: accepted.id })).records[0]!;
  expect(record.applicability.p?.state).toBe('needs-review');
  expect((await loadMemory(root)).records[0]?.applicability.p?.state).toBe('needs-review');
});
it('starts no evidence watcher for a watcher event that arrives while disposing', async () => {
  const { root, authority, memory, events } = await fixture();
  const disposed = memory.dispose();
  // The event queues a refresh behind the operations dispose waits for.
  events.get(root)!(null, [{ path: join(root, 'rules.md'), type: 'update' }]);
  await disposed;
  await expect(memory.run(authority, { action: 'list', search: '', state: 'all', offset: 0 })).rejects.toThrow(
    'UNAVAILABLE',
  );
  expect(events.size).toBe(0);
});
it('pins watcher epochs during review and keeps the prior reviewed revision on a race', async () => {
  const { root, authority, accepted, save } = await fixture();
  // Inject the event at the generation check after the evidence has been read twice.
  let receive: Parameters<WatchSubscribe>[1];
  let reads = 0;
  const raced = new LearningMemory(
    () => {
      if (++reads === 2) receive(null, [{ path: join(root, 'rules.md'), type: 'update' }]);
      return undefined;
    },
    (_, callback) => {
      receive = callback;
      return Promise.resolve({ unsubscribe: () => Promise.resolve() });
    },
  );
  cleanup.push(() => raced.dispose());
  await expect(
    raced.run(authority, {
      action: 'review',
      id: accepted.id,
      expectedRevision: accepted.revision,
      idempotencyKey: 'raced-review',
      decision: 'accept',
    }),
  ).rejects.toThrow('EVIDENCE_CHANGED');
  expect((await loadMemory(root)).records[0]?.revision).toBe(accepted.revision);
  await expect(
    evidenceFor(authority, { ...save.draft, evidence: [{ path: 'rules.md', span: [1, 0, 100, 0] }] }),
  ).rejects.toThrow('span exceeds');
});
it('archives before removal, keeps the original identity, promotes explicitly and checks other checkouts independently', async () => {
  const { root, authority, memory, save } = await fixture();
  const tree = await mkdtemp(join(tmpdir(), 'oxy-learning-worktree-'));
  cleanup.push(() => rm(tree, { recursive: true, force: true }));
  await writeFile(join(tree, 'rules.md'), 'Worktree protocol.\n');
  const checkout = {
    ...authority,
    root: tree,
    checkoutId: 'worktree:t',
    checkouts: [...authority.checkouts, { checkoutId: 'worktree:t', root: tree }],
  };
  const record = (await memory.run(checkout, { ...save, idempotencyKey: 'worktree' })).records[0]!;
  await memory.archive(checkout);
  expect(await listArchives(root)).toEqual(['worktree:t']);
  expect((await loadMemory(tree)).records).toEqual([]);
  await rm(tree, { recursive: true, force: true });
  const archived = { ...authority, checkoutId: checkout.checkoutId, archived: true };
  expect(
    (await memory.run(authority, { action: 'list', search: '', state: 'all', offset: 0 })).records.map((r) => r.id),
  ).not.toContain(record.id);
  expect((await memory.run(archived, { action: 'get', id: record.id })).records[0]?.checkoutId).toBe(
    checkout.checkoutId,
  );
  // Resolve the topic explicitly; unrelated active alternatives cannot be accepted just because they were created earlier.
  const main = (await memory.run(authority, { action: 'list', search: '', state: 'all', offset: 0 })).records[0]!;
  await memory.run(authority, {
    action: 'review',
    id: main.id,
    expectedRevision: main.revision,
    decision: 'reject',
    idempotencyKey: 'reject-main',
  });
  const promoted = (
    await memory.run(archived, {
      action: 'review',
      id: record.id,
      expectedRevision: record.revision,
      decision: 'promote',
      idempotencyKey: 'promote',
    })
  ).records[0]!;
  expect(promoted.scope).toBe('project');
  expect(promoted.checkoutId).toBe(checkout.checkoutId);
  expect(promoted.applicability.p?.state).toBe('current');
  const second = join(root, 'second');
  await mkdir(second);
  await writeFile(join(second, 'rules.md'), 'Different evidence.');
  const other = {
    ...authority,
    checkoutId: 'worktree:other',
    root: second,
    checkouts: [...authority.checkouts, { checkoutId: 'worktree:other', root: second }],
  };
  const found = (await memory.run(other, { action: 'get', id: record.id })).records[0]!;
  expect(found.applicability['worktree:other']?.state).toBe('needs-review');
  expect(found.applicability.p?.state).toBe('current');
  const revalidated = (
    await memory.run(authority, {
      action: 'review',
      id: found.id,
      expectedRevision: found.revision,
      decision: 'accept',
      idempotencyKey: 'main-revalidation',
    })
  ).records[0]!;
  expect(revalidated.applicability['worktree:other']?.state).toBe('needs-review');
});
it('includes other instances and archived revisions in project-wide reservations', async () => {
  const { root, authority } = await fixture();
  const stores = new Map([
    [
      { checkoutId: 'foreign-live', root },
      { ...emptyMemory(), records: Array.from({ length: 1999 }, () => ({})) },
    ],
  ]);
  // Only usage accounting consumes the record count; no fabricated record is ever admitted to a store.
  const finalize = await reserveMemory(root, stores as Parameters<typeof reserveMemory>[1]);
  await finalize();
  const another = new LearningMemory(
    () => undefined,
    () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
  );
  cleanup.push(() => another.dispose());
  await expect(
    another.run(authority, {
      action: 'save',
      draft: LearningDraftSchema.parse({ kind: 'decision', title: 'Additional', body: 'Another finding.' }),
      expectedRevision: 0,
      idempotencyKey: 'over-budget',
    }),
  ).rejects.toThrow('MEMORY_LIMIT');
  expect((await loadMemory(root)).records).toHaveLength(1);
  expect((await another.run(authority, { action: 'list', search: '', state: 'all', offset: 0 })).records).toHaveLength(
    1,
  );
});
it('keeps idempotency machine-local and replays every interrupted publication boundary', async () => {
  const { root, accepted } = await fixture();
  expect(await readFile(join(root, '.oxy/learnings/learnings.json'), 'utf8')).not.toContain('retries');
  const original = writer.atomicWrite;
  for (const boundary of ['recovery.json', 'learnings.json', 'metadata.json']) {
    const file = await loadMemory(root);
    file.revision++;
    file.records[0]!.body = `Recovered at ${boundary}`;
    vi.spyOn(writer, 'atomicWrite').mockImplementation(async (path, ...args) => {
      if (path.endsWith(boundary)) throw new Error('injected crash');
      return original(path, ...args);
    });
    await expect(writeMemory(root, file)).rejects.toThrow('injected crash');
    vi.restoreAllMocks();
    const recovered = await loadMemory(root);
    expect(recovered.revision).toBe(file.revision);
    expect(recovered.records[0]?.body).toBe(`Recovered at ${boundary}`);
    expect(recovered.records[0]?.id).toBe(accepted.id);
  }
});
it('refuses another writer without corrupting the reviewed finding and rejects replacement cycles', async () => {
  const { root, authority, memory, accepted, save } = await fixture();
  const { lease } = await OwnerLock.acquire(
    await safeDirectory(root, ['.oxy', 'learnings', 'local']),
    'other instance',
  );
  try {
    await expect(memory.run(authority, { action: 'get', id: accepted.id })).rejects.toThrow('MEMORY_BUSY');
  } finally {
    await lease?.dispose();
  }
  await expect(
    memory.run(authority, {
      ...save,
      id: accepted.id,
      expectedRevision: accepted.revision,
      draft: { ...save.draft, replaces: accepted.id },
      idempotencyKey: 'cycle',
    }),
  ).rejects.toThrow('CONFLICT');
  expect((await loadMemory(root)).records[0]?.review).toBe('accepted');
});

it('serializes competing instances and reports an optimistic revision conflict', async () => {
  const { authority, memory, accepted, save, subscribe } = await fixture();
  const second = new LearningMemory(() => undefined, subscribe);
  cleanup.push(() => second.dispose());
  const edit = { ...save, id: accepted.id, expectedRevision: accepted.revision };
  const outcomes = await Promise.allSettled([
    memory.run(authority, { ...edit, idempotencyKey: 'writer-a', draft: { ...save.draft, body: 'Writer A' } }),
    second.run(authority, { ...edit, idempotencyKey: 'writer-b', draft: { ...save.draft, body: 'Writer B' } }),
  ]);
  expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(String((outcomes.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toContain(
    'REVISION_CONFLICT',
  );
});

it('requires review to resolve two alternatives replacing the same claim even without a topic', async () => {
  const { authority, memory, accepted, save } = await fixture();
  const alternatives = [];
  for (const title of ['Alternative A', 'Alternative B'])
    alternatives.push(
      (
        await memory.run(authority, {
          ...save,
          draft: { ...save.draft, title, topic: undefined, replaces: accepted.id },
          idempotencyKey: title,
        })
      ).records[0]!,
    );
  await memory.run(authority, {
    action: 'review',
    id: alternatives[0]!.id,
    expectedRevision: alternatives[0]!.revision,
    decision: 'accept',
    idempotencyKey: 'accept-a',
  });
  await expect(
    memory.run(authority, {
      action: 'review',
      id: alternatives[1]!.id,
      expectedRevision: alternatives[1]!.revision,
      decision: 'accept',
      idempotencyKey: 'accept-b',
    }),
  ).rejects.toThrow('CONFLICT');
});

it('replays a crash between archive and source publication, then forgets every recovery copy', async () => {
  const { root, authority, memory, save } = await fixture();
  const tree = join(root, 'crash-tree');
  await mkdir(tree);
  await writeFile(join(tree, 'rules.md'), 'Archive evidence.');
  const checkout = {
    ...authority,
    checkoutId: 'worktree:crash',
    root: tree,
    checkouts: [...authority.checkouts, { checkoutId: 'worktree:crash', root: tree }],
  };
  await memory.run(checkout, save);
  // The writer uses canonical paths, whose casing can differ from tmpdir() on Windows.
  const sourcePath = join(await safeDirectory(tree, ['.oxy', 'learnings'], false), 'learnings.json');
  const original = writer.atomicWrite;
  vi.spyOn(writer, 'atomicWrite').mockImplementation((path, ...args) =>
    path === sourcePath ? Promise.reject(new Error('archive crash')) : original(path, ...args),
  );
  await expect(memory.archive(checkout)).rejects.toThrow('archive crash');
  vi.restoreAllMocks();
  const restarted = new LearningMemory(
    () => undefined,
    () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
  );
  cleanup.push(() => restarted.dispose());
  const archived = { ...checkout, root, archived: true };
  const recovered = await restarted.run(archived, { action: 'list', search: '', state: 'all', offset: 0 });
  expect(recovered.records).toHaveLength(1);
  expect((await loadMemory(tree)).records).toEqual([]);
  await restarted.run(archived, {
    action: 'forget',
    expectedRevision: recovered.memoryRevision,
    idempotencyKey: 'forget-archive',
  });
  const file = await loadMemory(root, checkout.checkoutId);
  expect(file.records).toEqual([]);
  expect(file.history).toEqual([]);
  expect(JSON.stringify(file)).not.toContain(save.draft.body);
  await expect(readFile(join(root, '.oxy/learnings/local/transaction.json'))).rejects.toThrow();
});

it.skipIf(process.platform === 'win32')(
  'rejects evidence aliases to secrets or outside the authorized checkout',
  async () => {
    const { root, authority, save } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'oxy-evidence-outside-'));
    cleanup.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, 'outside.md'), 'Outside data.');
    await writeFile(join(root, '.env'), 'SECRET=never-read');
    await symlink(join(root, '.env'), join(root, 'secret-alias.md'));
    await symlink(join(outside, 'outside.md'), join(root, 'outside-alias.md'));
    for (const path of ['secret-alias.md', 'outside-alias.md'])
      await expect(evidenceFor(authority, { ...save.draft, evidence: [{ path }] })).rejects.toThrow('Excluded');
  },
);
