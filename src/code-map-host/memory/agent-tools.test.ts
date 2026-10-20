import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { emptyCodeMapCoverage, type CodeMapGraph } from '@shared/domain/code-map';
import type { MemoryAuthority } from '@shared/domain/code-map-memory';
import { LearningDraftSchema } from '@shared/domain/code-map-memory';
import {
  LearningToolRequestSchema,
  TaskContextQuerySchema,
  type LearningActor,
} from '@shared/domain/code-map-learning-tools';
import { fileRecord } from '../extract/files';
import { LearningMemory } from './admission';
import { LearningTools } from './agent-tools';
import { ContextReceipts } from './receipts';
import { taskContext } from './context';
import { loadMemory } from './store';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'oxy-learning-tools-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = 'export function protocol() { return 1; }\n';
  await writeFile(join(root, 'api.ts'), source);
  await writeFile(join(root, 'rules.md'), 'Use the protocol.\n');
  const file = fileRecord('api.ts', source).file;
  file.status = 'ok';
  const other = fileRecord('client.ts', 'import protocol').file;
  const graph: CodeMapGraph = {
    format: 'oxytocin.code-map',
    schemaVersion: 1,
    generator: { oxytocin: 'test', extractors: {}, grammars: {}, settingsHash: '0'.repeat(64) },
    files: [file, other],
    groups: [],
    packages: [],
    unresolved: [],
    coverage: emptyCodeMapCoverage(),
    symbols: [
      {
        id: 's:protocol',
        file: file.id,
        name: 'protocol',
        kind: 'function',
        signature: 'function protocol()',
        owner: null,
        exported: true,
        span: [1, 0, 1, source.trimEnd().length],
      },
    ],
    edges: [{ from: other.id, to: file.id, rel: 'imports', prov: 'binding' }],
  };
  let generation = 1;
  const freshness = () => ({
    generation,
    state: 'ready' as const,
    stale: false,
    verification: 'content-hash' as const,
    checkedAt: null,
    lastFullHashAt: null,
    pendingFiles: 0,
    coverage: graph.coverage,
    warnings: [],
  });
  const snapshot = () => ({ graph, generation });
  const memory = new LearningMemory(snapshot, () => Promise.resolve({ unsubscribe: () => Promise.resolve() }));
  cleanup.push(() => memory.dispose());
  const tools = new LearningTools(
    {
      memorySnapshot: snapshot,
      cancelQuery: () => {},
      query: (checkoutId) =>
        Promise.resolve({ checkoutId, code: 'OK', freshness: freshness(), reasons: [], truncated: false, hint: '' }),
    },
    memory,
  );
  const authority: MemoryAuthority = {
    projectId: 'p',
    checkoutId: 'p',
    root,
    projectRoot: root,
    checkouts: [{ checkoutId: 'p', root }],
    excludedPaths: [],
    origin: { source: 'user' },
  };
  const actor: LearningActor = { session: 'session-one', principal: 'hub', role: 'hub' };
  let sequence = 0;
  const run = (request: Parameters<LearningTools['run']>[3], who = actor, mode: 'review' | 'off' = 'review') =>
    tools.run(`r${++sequence}`, authority, who, request, mode);
  const draft = LearningDraftSchema.parse({
    kind: 'constraint',
    title: 'Protocol rule',
    body: 'Use the protocol.',
    rationale: 'Preserve compatible clients.',
    evidence: [{ path: 'api.ts', symbolId: 's:protocol' }],
  });
  const propose = () => run({ kind: 'propose', draft, expectedRevision: 0, idempotencyKey: 'proposal' });
  const accept = async () => {
    const proposed = await propose();
    if (proposed.kind !== 'propose') throw new Error(JSON.stringify(proposed));
    await memory.run(authority, {
      action: 'review',
      id: proposed.id,
      expectedRevision: proposed.revision,
      decision: 'accept',
      idempotencyKey: 'accept',
    });
    return proposed.id;
  };
  const context = async (who = actor, mode: 'review' | 'off' = 'review') => {
    const result = await run(
      { kind: 'task-context', question: 'protocol compatibility', paths: ['api.ts'] },
      who,
      mode,
    );
    if (result.kind !== 'task-context') throw new Error(JSON.stringify(result));
    return result;
  };
  return {
    root,
    authority,
    actor,
    memory,
    tools,
    run,
    draft,
    propose,
    accept,
    context,
    graph,
    freshness,
    setGeneration: (value: number) => {
      generation = value;
    },
  };
}

it('queues authenticated proposals, then reuses reviewed knowledge in a later independent session', async () => {
  const { root, memory, authority, actor, propose, accept, context } = await fixture();
  const proposed = await propose();
  expect(proposed).toMatchObject({ kind: 'propose', review: 'proposed', applicability: 'pending' });
  expect((await context()).learnings).toEqual([]);
  const id = await accept();
  const later = await context({ ...actor, session: 'independent-session' });
  expect(later.learnings).toHaveLength(1);
  expect(later.learnings[0]).toMatchObject({
    id,
    origin: { source: 'agent', role: 'hub' },
    reviewer: { source: 'user' },
    review: 'accepted',
    applicability: { state: 'current' },
  });
  expect(later.nodes.some((n) => n.path === 'api.ts')).toBe(true);
  expect(JSON.stringify(later).length).toBeLessThanOrEqual(8000);
  const stored = (await memory.run(authority, { action: 'get', id })).records[0]!;
  expect(stored.origin.source).toBe('agent');
  expect(await readFile(join(root, '.oxy/learnings/learnings.json'), 'utf8')).not.toContain('retries');
});
it('binds feedback to the emitted revision/session and counts idempotent or repeated feedback only once', async () => {
  const { root, actor, accept, context, run, memory, authority } = await fixture();
  const id = await accept(),
    selected = await context();
  const feedback = {
    kind: 'feedback' as const,
    receipt: selected.receipt!,
    id,
    revision: selected.learnings[0]!.revision,
    outcome: 'used' as const,
    idempotencyKey: 'used',
  };
  expect(await run(feedback, { ...actor, session: 'forged-session' })).toMatchObject({ code: 'INVALID_RECEIPT' });
  expect(await run({ ...feedback, revision: feedback.revision + 1 })).toMatchObject({ code: 'INVALID_RECEIPT' });
  expect(await run(feedback)).toMatchObject({ kind: 'feedback', code: 'OK', duplicate: false });
  expect(await run(feedback)).toMatchObject({ duplicate: true });
  expect(await run({ ...feedback, idempotencyKey: 'different-retry-key' })).toMatchObject({ duplicate: true });
  expect((await memory.run(authority, { action: 'get', id })).records[0]?.feedback.used).toBe(1);
  expect(await readFile(join(root, '.oxy/learnings/learnings.json'), 'utf8')).not.toContain('"feedback"');
  expect(await run({ ...feedback, outcome: 'incorrect', idempotencyKey: 'negative' })).toMatchObject({
    applicability: 'needs-review',
  });
  expect((await context()).learnings).toEqual([]);
  expect((await memory.run(authority, { action: 'get', id })).records[0]?.review).toBe('accepted');
});
it('omits changed evidence and keeps code available with memory off or unavailable', async () => {
  const { root, accept, context, run, actor } = await fixture();
  await accept();
  await writeFile(join(root, 'api.ts'), 'export function changed() {}\n');
  expect((await context()).learnings).toEqual([]);
  const off = await context(actor, 'off');
  expect(off).toMatchObject({ memory: 'off', learnings: [] });
  expect(off.receipt).toBeUndefined();
  expect(off.nodes.length).toBeGreaterThan(0);
  expect(
    await run(
      {
        kind: 'propose',
        draft: { kind: 'decision', title: 'Off', body: 'Not saved.' },
        expectedRevision: 0,
        idempotencyKey: 'off',
      },
      actor,
      'off',
    ),
  ).toMatchObject({ code: 'MEMORY_OFF' });
  await writeFile(join(root, '.oxy/learnings/learnings.json'), JSON.stringify({ schemaVersion: 99 }));
  const unavailable = await context();
  expect(unavailable.memory).toBe('unavailable');
  expect(unavailable.learnings).toEqual([]);
  expect(unavailable.nodes.length).toBeGreaterThan(0);
});
it('preserves complete claims within the output budget, caps reuse at three and reports tiny budgets', async () => {
  const { accept, run, draft, authority, memory, graph, freshness } = await fixture();
  await accept();
  for (let i = 0; i < 4; i++) {
    const saved = await run({
      kind: 'propose',
      draft: { ...draft, title: `Protocol ${i}`, body: 'Protocol '.repeat(160), rationale: 'Rationale '.repeat(110) },
      expectedRevision: 0,
      idempotencyKey: `long-${i}`,
    });
    if (saved.kind !== 'propose') throw new Error(JSON.stringify(saved));
    await memory.run(authority, {
      action: 'review',
      id: saved.id,
      expectedRevision: saved.revision,
      decision: 'accept',
      idempotencyKey: `accept-${i}`,
    });
  }
  const knowledge = await memory.context(authority);
  for (const budget of [2000, 8000, 24000]) {
    const result = taskContext(
      TaskContextQuerySchema.parse({ question: 'Protocol', paths: ['api.ts'], maxChars: budget }),
      graph,
      freshness(),
      knowledge,
      'ready',
      'p',
      'receipt',
    );
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(budget);
    expect(result.learnings.length).toBeLessThanOrEqual(3);
    for (const r of result.learnings) expect(r.body).toBe(knowledge.records.find((k) => k.id === r.id)!.body);
  }
  expect(await run({ kind: 'task-context', question: 'protocol', maxChars: 1 })).toMatchObject({
    code: 'BUDGET_TOO_SMALL',
  });
});
it('enforces 50 proposals per checkout/hour while allowing a keyed retry and preserving reads', async () => {
  const { run, draft, context } = await fixture();
  for (let i = 0; i < 50; i++)
    expect(
      await run({
        kind: 'propose',
        draft: { ...draft, title: `Rule ${i}`, evidence: [] },
        expectedRevision: 0,
        idempotencyKey: `rate-${i}`,
      }),
    ).toMatchObject({ code: 'OK' });
  expect(
    await run({
      kind: 'propose',
      draft: { ...draft, title: 'Rule 49', evidence: [] },
      expectedRevision: 0,
      idempotencyKey: 'rate-49',
    }),
  ).toMatchObject({ duplicate: true });
  expect(await run({ kind: 'propose', draft, expectedRevision: 0, idempotencyKey: 'fifty-one' })).toMatchObject({
    code: 'RATE_LIMIT',
  });
  expect((await context()).learnings).toEqual([]);
}, 30000);
it('expires receipts, refuses other checkouts, revokes actors and retains no original question', async () => {
  const { accept, context, actor } = await fixture();
  await accept();
  const result = await context();
  let now = 0;
  const receipts = new ContextReceipts(() => now);
  const receipt = receipts.create('p', actor, result);
  expect(() => receipts.inspect(receipt, 'p', 'worktree:other')).toThrow('INVALID_RECEIPT');
  expect(JSON.stringify(receipts.inspect(receipt, 'p', 'p'))).not.toContain('protocol compatibility');
  now = 30 * 60000;
  expect(() => receipts.inspect(receipt, 'p', 'p')).toThrow('RECEIPT_EXPIRED');
  const renewed = receipts.create('p', actor, result);
  receipts.revokeActor(actor.principal);
  expect(() => receipts.inspect(renewed, 'p', 'p')).toThrow('RECEIPT_EXPIRED');
});
it('refuses spoofed authors/hashes and supports revoking an in-flight proposal before publication', async () => {
  const { authority, actor, draft, graph, memory } = await fixture();
  expect(
    LearningToolRequestSchema.safeParse({
      kind: 'propose',
      draft,
      expectedRevision: 0,
      idempotencyKey: 'x',
      author: 'user',
    }).success,
  ).toBe(false);
  expect(
    LearningToolRequestSchema.safeParse({
      kind: 'propose',
      draft: { ...draft, evidence: [{ path: 'api.ts', hash: 'claimed' }] },
      expectedRevision: 0,
      idempotencyKey: 'x',
    }).success,
  ).toBe(false);
  let reads = 0;
  const raced = new LearningMemory(
    () => {
      if (++reads === 2) tools.cancel('cancelled');
      return { graph, generation: 1 };
    },
    () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
  );
  cleanup.push(() => raced.dispose());
  const tools = new LearningTools(
    {
      memorySnapshot: () => ({ graph, generation: 1 }),
      query: () => Promise.reject(new Error('unused')),
      cancelQuery: () => {},
    },
    raced,
  );
  expect(
    await tools.run(
      'cancelled',
      authority,
      actor,
      { kind: 'propose', draft, expectedRevision: 0, idempotencyKey: 'cancel' },
      'review',
    ),
  ).toMatchObject({ code: 'CANCELLED' });
  expect((await loadMemory(authority.root)).records).toEqual([]);
  expect((await memory.context(authority)).records).toEqual([]);
});
