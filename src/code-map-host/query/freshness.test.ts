import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { copyCodeMapAssets } from '../../../scripts/code-map-assets';
import { CodeMapCheckouts } from '../checkouts';
import { fileRecord } from '../extract/files';

let assets: string;
let root: string;
let checkouts: CodeMapCheckouts;
beforeAll(async () => {
  assets = await mkdtemp(join(tmpdir(), 'oxy-query-assets-'));
  await copyCodeMapAssets(assets);
});
afterAll(async () => {
  await rm(assets, { recursive: true, force: true });
});
afterEach(async () => {
  await checkouts?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});
async function setup(gate?: () => Promise<void>) {
  root = await mkdtemp(join(tmpdir(), 'oxy-query-'));
  await writeFile(join(root, 'api.ts'), 'first');
  const parse = vi.fn(async (path: string, source: string) => {
    await gate?.();
    const record = fileRecord(path, source);
    record.file.status = 'ok';
    record.symbols = [
      {
        id: `s:${path}:${source}`,
        file: record.file.id,
        name: source,
        kind: 'function',
        signature: `function ${source}()`,
        span: [1, 0, 1, source.length],
        exported: true,
        owner: null,
      },
    ];
    return record;
  });
  checkouts = new CodeMapCheckouts('Oxytocin test', () => {}, {
    assets,
    parserEntry: '',
    parser: { parse, dispose: async () => {} },
  });
  await checkouts.configure({
    checkoutId: 'p',
    projectId: 'p',
    root,
    mode: 'project',
    gitPath: 'git',
    ignoreInGit: false,
  });
  return parse;
}
it('coalesces ten queries after an immediate edit, pins one generation and reports verified coverage', async () => {
  const parse = await setup();
  await vi.waitFor(() => expect(checkouts.status('p').state).toBe('ready'));
  parse.mockClear();
  await writeFile(join(root, 'api.ts'), 'second');
  const answers = await Promise.all(
    Array.from({ length: 10 }, (_, i) => checkouts.query('p', `q${i}`, { kind: 'search', query: 'second' })),
  );
  expect(parse).toHaveBeenCalledTimes(1);
  expect(new Set(answers.map((answer) => answer.freshness.generation)).size).toBe(1);
  for (const answer of answers) {
    expect(answer.code).toBe('OK');
    expect(answer.freshness.stale).toBe(false);
    expect(answer.data).toMatchObject({ kind: 'search', matches: [expect.objectContaining({ name: 'second' })] });
  }
  const verified = await checkouts.query('p', 'v', { kind: 'outline', path: 'api.ts', freshness: 'verified' });
  expect(verified.freshness.verification).toBe('content-hash');
  expect(verified.freshness.lastFullHashAt).toBe(verified.freshness.checkedAt);
  checkouts.pause('p');
  expect((await checkouts.query('p', 'paused', { kind: 'search', query: 'nope' })).code).toBe('INDEX_PAUSED');
  expect(
    (await checkouts.query('p', 'stale', { kind: 'outline', path: 'api.ts', freshness: 'allow-stale' })).freshness
      .stale,
  ).toBe(true);
});
it('returns INDEX_UPDATING instead of no matches and cancellation does not abort shared refresh', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await setup(() => gate);
    const timed = await checkouts.query('p', 'timeout', { kind: 'search', query: 'absent' });
    expect(timed.code).toBe('INDEX_UPDATING');
    expect(timed.data).toBeUndefined();
    const cancelled = checkouts.query('p', 'cancel', { kind: 'search', query: 'first' });
    const survivor = checkouts.query('p', 'survive', { kind: 'outline', path: 'api.ts' });
    checkouts.cancelQuery('cancel');
    await expect(cancelled).rejects.toThrow();
    release();
    expect((await survivor).code).toBe('OK');
  } finally {
    release?.();
  }
}, 15000);
it('answers from the published snapshot when the freshness wait expires, and keeps verified and paused strict', async () => {
  let block: Promise<void> = Promise.resolve();
  let release: () => void = () => {};
  try {
    await setup(() => block);
    await vi.waitFor(() => expect(checkouts.status('p').state).toBe('ready'));
    block = new Promise<void>((resolve) => {
      release = resolve;
    });
    await writeFile(join(root, 'api.ts'), 'second');
    const lagging = await checkouts.query('p', 'lagging', { kind: 'search', query: 'first' });
    expect(lagging.code).toBe('OK');
    expect(lagging.freshness).toMatchObject({ stale: true, pendingFiles: 1 });
    expect(lagging.data).toMatchObject({ kind: 'search', matches: [expect.objectContaining({ name: 'first' })] });
    const verified = await checkouts.query('p', 'strict', { kind: 'search', query: 'first', freshness: 'verified' });
    expect(verified.code).toBe('INDEX_UPDATING');
    expect(verified.data).toBeUndefined();
    release();
    await vi.waitFor(async () => {
      const current = await checkouts.query('p', `current-${Math.random()}`, { kind: 'search', query: 'second' });
      expect(current.freshness.stale).toBe(false);
      expect(current.data).toMatchObject({ kind: 'search', matches: [expect.objectContaining({ name: 'second' })] });
    });
  } finally {
    release();
  }
}, 20000);
it('audits only for verified queries or an untrusted watcher; latest answers from the snapshot otherwise', async () => {
  const { CheckoutIndexer } = await import('../indexer');
  const verify = vi.spyOn(CheckoutIndexer.prototype, 'verify');
  try {
    await setup();
    await vi.waitFor(() => expect(checkouts.status('p').state).toBe('ready'));
    verify.mockClear();
    for (let i = 0; i < 5; i++) {
      const answer = await checkouts.query('p', `idle-${i}`, { kind: 'search', query: 'first' });
      expect(answer.freshness).toMatchObject({ stale: false, pendingFiles: 0 });
      expect(answer.data).toMatchObject({ kind: 'search', matches: [expect.objectContaining({ name: 'first' })] });
    }
    expect(verify).not.toHaveBeenCalled();
    // An edit is picked up through the pending event, still without an audit.
    await writeFile(join(root, 'api.ts'), 'second');
    const edited = await checkouts.query('p', 'edited', { kind: 'search', query: 'second' });
    expect(edited.freshness.stale).toBe(false);
    expect(edited.data).toMatchObject({ kind: 'search', matches: [expect.objectContaining({ name: 'second' })] });
    expect(verify).not.toHaveBeenCalled();
    await checkouts.query('p', 'strict', { kind: 'search', query: 'second', freshness: 'verified' });
    expect(verify).toHaveBeenCalledWith(true);
  } finally {
    verify.mockRestore();
  }
});
