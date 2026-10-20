import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { LearningDraftSchema, LearningOperationSchema, type MemoryAuthority } from '@shared/domain/code-map-memory';
import { LearningMemory } from './admission';
import { checkApplicability, evidenceFor } from './applicability';
import { emptyMemory, loadMemory, writeMemory } from './store';
import { emptyCodeMapCoverage, type CodeMapGraph } from '@shared/domain/code-map';
import { fileRecord } from '../extract/files';
import { sha256 } from '../store/writer';

const roots: string[] = [];
const memories: LearningMemory[] = [];
afterEach(async () => {
  for (const memory of memories.splice(0)) await memory.dispose();
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'oxy-learning-storage-'));
  roots.push(root);
  await writeFile(join(root, 'rules.md'), 'Use the supported protocol.\n');
  const authority: MemoryAuthority = {
    projectId: 'project',
    checkoutId: 'project',
    root,
    projectRoot: root,
    checkouts: [{ checkoutId: 'project', root }],
    excludedPaths: [],
    origin: { source: 'user' },
  };
  const memory = new LearningMemory(() => undefined);
  memories.push(memory);
  const draft = LearningDraftSchema.parse({
    kind: 'constraint',
    title: 'Protocol requirement',
    body: 'Keep the supported protocol.',
    evidence: [{ path: 'rules.md' }],
  });
  const save = { action: 'save' as const, draft, expectedRevision: 0, idempotencyKey: 'first' };
  return { root, authority, memory, draft, save };
}
describe('durable learnings foundation', () => {
  it('keeps raw evidence hashes while comparing normalized indexed sources and independent documents', async () => {
    const { root, authority, draft } = await setup();
    const source = '\ufeffexport function protocol() {}\r\n';
    await writeFile(join(root, 'api.ts'), source);
    const sourceFile = fileRecord('api.ts', source).file;
    sourceFile.status = 'ok';
    const graph: CodeMapGraph = {
      format: 'oxytocin.code-map',
      schemaVersion: 1,
      generator: { oxytocin: 'test', extractors: {}, grammars: {}, settingsHash: `sha256:${'0'.repeat(64)}` },
      files: [sourceFile, fileRecord('rules.md', 'older document').file],
      groups: [],
      packages: [],
      symbols: [],
      edges: [],
      unresolved: [],
      coverage: emptyCodeMapCoverage(),
    };
    const sourceEvidence = await evidenceFor(authority, { ...draft, evidence: [{ path: 'api.ts' }] }, graph);
    expect(sourceEvidence[0]?.hash).toBe(sha256(source));
    expect(sourceEvidence[0]?.hash).not.toBe(sourceFile.sha256);
    expect((await evidenceFor(authority, draft, graph))[0]?.hash).toBe(sha256(await readFile(join(root, 'rules.md'))));
    await writeFile(join(root, 'api.ts'), 'export function changed() {}');
    await expect(evidenceFor(authority, { ...draft, evidence: [{ path: 'api.ts' }] }, graph)).rejects.toThrow(
      'EVIDENCE_CHANGED',
    );
  });
  it('does not create .oxy when inspecting a project without findings', async () => {
    const { root, authority, memory } = await setup();
    expect((await memory.run(authority, { action: 'list', search: '', state: 'all', offset: 0 })).total).toBe(0);
    await expect(readFile(join(root, '.oxy/learnings/learnings.json'))).rejects.toThrow();
  });
  it('deduplicates retries, detects key reuse and prevents silent revision overwrites', async () => {
    const { authority, memory, save } = await setup();
    const first = await memory.run(authority, save);
    expect(first.records[0]?.review).toBe('proposed');
    const repeated = await memory.run(authority, save);
    expect(repeated.duplicate).toBe(true);
    expect(repeated.records[0]?.id).toBe(first.records[0]?.id);
    await expect(memory.run(authority, { ...save, draft: { ...save.draft, body: 'Different' } })).rejects.toThrow(
      'IDEMPOTENCY_CONFLICT',
    );
    const dedup = await memory.run(authority, { ...save, idempotencyKey: 'same-finding' });
    expect(dedup.records[0]?.id).toBe(first.records[0]?.id);
    const record = first.records[0]!;
    await expect(
      memory.run(authority, {
        action: 'review',
        id: record.id,
        expectedRevision: 0,
        decision: 'accept',
        idempotencyKey: 'review',
      }),
    ).rejects.toThrow('REVISION_CONFLICT');
    expect((await memory.run(authority, { action: 'list', search: '', state: 'all', offset: 0 })).total).toBe(1);
  });
  it('latches changed evidence, survives restart and requires explicit revalidation after reverting', async () => {
    const { root, authority, memory, save } = await setup();
    let record = (await memory.run(authority, save)).records[0]!;
    record = (
      await memory.run(authority, {
        action: 'review',
        id: record.id,
        expectedRevision: record.revision,
        decision: 'accept',
        idempotencyKey: 'accept',
      })
    ).records[0]!;
    expect(record.applicability.project?.state).toBe('current');
    const original = await readFile(join(root, 'rules.md'), 'utf8');
    await writeFile(join(root, 'rules.md'), 'The protocol changed.');
    const restarted = new LearningMemory(() => undefined);
    memories.push(restarted);
    record = (await restarted.run(authority, { action: 'get', id: record.id })).records[0]!;
    expect(record.applicability.project?.state).toBe('needs-review');
    await writeFile(join(root, 'rules.md'), original);
    record = (await restarted.run(authority, { action: 'get', id: record.id })).records[0]!;
    expect(record.applicability.project?.state).toBe('needs-review');
    record = (
      await restarted.run(authority, {
        action: 'review',
        id: record.id,
        expectedRevision: record.revision,
        decision: 'accept',
        idempotencyKey: 'revalidate',
      })
    ).records[0]!;
    expect(record.applicability.project?.state).toBe('current');
  });
  it('requires review of unanchored findings after 30 days', async () => {
    const { authority, memory, save } = await setup();
    let record = (await memory.run(authority, { ...save, draft: { ...save.draft, evidence: [] } })).records[0]!;
    record = (
      await memory.run(authority, {
        action: 'review',
        id: record.id,
        expectedRevision: record.revision,
        decision: 'accept',
        idempotencyKey: 'accept',
      })
    ).records[0]!;
    await checkApplicability(record, authority, undefined, Date.parse(record.reviewedAt!) + 31 * 86400000);
    expect(record.applicability.project?.state).toBe('needs-review');
  });
  it('blocks excluded, secret, binary and oversized evidence before admission', async () => {
    const { root, authority, memory, save } = await setup();
    await writeFile(join(root, '.env'), 'secret');
    await writeFile(join(root, 'binary.txt'), Buffer.from([0, 1]));
    await writeFile(join(root, 'large.txt'), 'a'.repeat(256 * 1024 + 1));
    for (const path of ['.env', 'binary.txt', 'large.txt'])
      await expect(memory.run(authority, { ...save, draft: { ...save.draft, evidence: [{ path }] } })).rejects.toThrow(
        'INVALID_EVIDENCE',
      );
    await expect(memory.run({ ...authority, excludedPaths: ['rules.md'] }, save)).rejects.toThrow('INVALID_EVIDENCE');
    expect(LearningDraftSchema.safeParse({ ...save.draft, evidence: [{ path: '../escape.md' }] }).success).toBe(false);
    expect(
      LearningDraftSchema.safeParse({ ...save.draft, evidence: [{ path: 'rules.md', hash: 'spoofed' }] }).success,
    ).toBe(false);
    expect(LearningOperationSchema.safeParse({ ...save, author: 'spoofed' }).success).toBe(false);
  });
  it('retains reviewed content until a replacement is explicitly accepted', async () => {
    const { authority, memory, save } = await setup();
    const first = (await memory.run(authority, save)).records[0]!;
    await memory.run(authority, {
      action: 'review',
      id: first.id,
      expectedRevision: first.revision,
      decision: 'accept',
      idempotencyKey: 'accept',
    });
    const replacement = (
      await memory.run(authority, {
        ...save,
        draft: { ...save.draft, title: 'Replacement', replaces: first.id },
        idempotencyKey: 'replacement',
      })
    ).records[0]!;
    expect((await memory.run(authority, { action: 'get', id: first.id })).records[0]?.review).toBe('accepted');
    await memory.run(authority, {
      action: 'review',
      id: replacement.id,
      expectedRevision: replacement.revision,
      decision: 'accept',
      idempotencyKey: 'accept-replacement',
    });
    expect((await memory.run(authority, { action: 'get', id: first.id })).records[0]?.review).toBe('superseded');
  });
  it('purges forgotten content from history, recovery and abandoned temporary files', async () => {
    const { root, authority, memory, save } = await setup();
    const record = (await memory.run(authority, save)).records[0]!;
    await memory.run(authority, {
      ...save,
      id: record.id,
      expectedRevision: record.revision,
      draft: { ...save.draft, body: 'Updated requirement.' },
      idempotencyKey: 'edit',
    });
    const file = await loadMemory(root);
    await writeFile(join(root, '.oxy/learnings/local/recovery.json.tmp-abandoned'), JSON.stringify(file));
    await memory.run(authority, { action: 'forget', expectedRevision: file.revision, idempotencyKey: 'forget' });
    await writeFile(join(root, '.oxy/learnings/learnings.json'), '{broken');
    const recovered = await loadMemory(root);
    expect(recovered.records).toEqual([]);
    expect(recovered.history).toEqual([]);
    expect(JSON.stringify(recovered)).not.toContain(save.draft.body);
    await expect(readFile(join(root, '.oxy/learnings/local/recovery.json.tmp-abandoned'))).rejects.toThrow();
  });
  it('replays a durable pending write and refuses incompatible schemas without replacing them', async () => {
    const { root } = await setup();
    await writeMemory(root, emptyMemory());
    const pending = { ...emptyMemory(), revision: 3 };
    await writeFile(join(root, '.oxy/learnings/local/pending.json'), JSON.stringify(pending));
    expect((await loadMemory(root)).revision).toBe(3);
    const incompatible = JSON.stringify({ ...emptyMemory(), schemaVersion: 99 });
    await writeFile(join(root, '.oxy/learnings/learnings.json'), incompatible);
    await expect(loadMemory(root)).rejects.toThrow('INCOMPATIBLE_SCHEMA');
    expect(await readFile(join(root, '.oxy/learnings/learnings.json'), 'utf8')).toBe(incompatible);
  });
  it('isolates checkout-local stores and never merges them through the project scope label', async () => {
    const { root, authority, memory, save } = await setup();
    const worktree = join(root, 'worktree');
    await mkdir(worktree);
    const checkoutAuthority = {
      ...authority,
      checkoutId: 'worktree:task',
      root: worktree,
      checkouts: [...authority.checkouts, { checkoutId: 'worktree:task', root: worktree }],
    };
    await memory.run(authority, save);
    expect(
      (await memory.run(checkoutAuthority, { action: 'list', search: '', state: 'all', offset: 0 })).records,
    ).toEqual([]);
  });
});
