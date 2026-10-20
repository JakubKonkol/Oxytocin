import { expect, it, vi } from 'vitest';
import type {
  PluginContext,
  PluginView,
  ViewProvider,
  CodeMapChange,
  CodeMapKnowledgeChange,
  Disposable,
} from '@oxytocin/plugin-api';
import { activate } from './index';

it('keeps Changes and Impact in the selected checkout and refuses a removed worktree without fallback', async () => {
  let provider: ViewProvider | undefined;
  const subscriptions: Disposable[] = [],
    disposable = { dispose() {} };
  const requests = new Map<string, (input: unknown) => unknown>();
  let available = true;
  const query = vi.fn((request: { checkoutId: string }) =>
    Promise.resolve({ checkoutId: request.checkoutId, code: 'OK' }),
  );
  const getCheckoutChanges = vi.fn(() =>
    Promise.resolve({
      projectId: 'p',
      checkoutId: 'worktree:t',
      comparison: 'worktree-base',
      baseCommit: 'a'.repeat(40),
      files: [{ path: 'new.ts', oldPath: 'old.ts', status: 'renamed' }],
      total: 1,
      truncated: false,
    }),
  );
  const ctx = {
    subscriptions,
    oxy: {
      projects: { getActive: () => Promise.resolve({ id: 'p' }), onDidChangeActive: () => disposable },
      commands: { register: () => disposable },
      git: { onDidChangeStatus: () => disposable, getCheckoutChanges },
      codeMap: {
        onDidChange: () => disposable,
        onDidChangeKnowledge: () => disposable,
        query,
        listCheckouts: () =>
          Promise.resolve([
            { projectId: 'p', checkoutId: 'p', mode: 'project' },
            ...(available ? [{ projectId: 'p', checkoutId: 'worktree:t', mode: 'worktree' }] : []),
          ]),
      },
      ui: {
        registerPanelProvider: (_id: string, p: ViewProvider) => {
          provider = p;
          return disposable;
        },
      },
    },
  } as unknown as PluginContext;
  await activate(ctx);
  await provider!.resolve({
    projectId: 'p',
    visible: true,
    onRequest: (id: string, handler: (input: unknown) => unknown) => {
      requests.set(id, handler);
      return disposable;
    },
    onDidDispose: () => disposable,
    onDidChangeVisibility: () => disposable,
  } as unknown as PluginView);
  const changes = await requests.get('query')!({ view: 'changes', checkoutId: 'worktree:t', depth: 3 });
  expect(getCheckoutChanges).toHaveBeenCalledWith({ projectId: 'p', checkoutId: 'worktree:t' });
  expect(query).toHaveBeenLastCalledWith(
    expect.objectContaining({
      checkoutId: 'worktree:t',
      view: 'impact',
      paths: ['new.ts', 'old.ts'],
      depth: 3,
      includeHeuristic: false,
    }),
    expect.anything(),
  );
  expect(changes).toMatchObject({ response: { checkoutId: 'worktree:t' }, changes: { comparison: 'worktree-base' } });
  await requests.get('query')!({ view: 'impact', checkoutId: 'worktree:t', root: { symbolId: 's:run' } });
  expect(query).toHaveBeenLastCalledWith(
    expect.objectContaining({ checkoutId: 'worktree:t', view: 'impact', root: { symbolId: 's:run' } }),
    expect.anything(),
  );
  await requests.get('query')!({ view: 'knowledge', checkoutId: 'worktree:t', learningState: 'stale' });
  expect(query).toHaveBeenLastCalledWith(
    expect.objectContaining({ checkoutId: 'worktree:t', view: 'knowledge', learningState: 'stale' }),
    expect.anything(),
  );
  await requests.get('query')!({ view: 'task-context', checkoutId: 'worktree:t', receipt: 'exact-receipt' });
  expect(query).toHaveBeenLastCalledWith(
    expect.objectContaining({ checkoutId: 'worktree:t', view: 'context-receipt', receipt: 'exact-receipt' }),
    expect.anything(),
  );
  available = false;
  await expect(Promise.resolve(requests.get('query')!({ view: 'changes', checkoutId: 'worktree:t' }))).rejects.toThrow(
    'no longer available',
  );
  expect(query).toHaveBeenCalledTimes(4);
  for (const sub of subscriptions) sub.dispose();
});

it('cancels hidden views and deduplicates reader audit invalidations without an update loop', async () => {
  let provider: ViewProvider | undefined,
    changed: ((change: CodeMapChange) => void) | undefined,
    knowledgeChanged: ((change: CodeMapKnowledgeChange) => void) | undefined,
    visible: ((shown: boolean) => void) | undefined;
  const requests = new Map<string, (input: unknown) => unknown>(),
    post = vi.fn(() => Promise.resolve(true)),
    subscriptions: Disposable[] = [];
  let signal: AbortSignal | undefined;
  const disposable = { dispose() {} };
  const ctx = {
    subscriptions,
    oxy: {
      projects: { getActive: () => Promise.resolve({ id: 'p' }), onDidChangeActive: () => disposable },
      commands: { register: () => disposable },
      git: { onDidChangeStatus: () => disposable },
      codeMap: {
        onDidChangeKnowledge: (listener: (c: CodeMapKnowledgeChange) => void) => {
          knowledgeChanged = listener;
          return disposable;
        },
        onDidChange: (listener: (c: CodeMapChange) => void) => {
          changed = listener;
          return disposable;
        },
        listCheckouts: () => Promise.resolve([{ projectId: 'p', checkoutId: 'p', mode: 'project' }]),
        query: (_request: unknown, options: { signal: AbortSignal }) => {
          signal = options.signal;
          return new Promise((_, reject) =>
            signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
          );
        },
      },
      ui: {
        registerPanelProvider: (_id: string, p: ViewProvider) => {
          provider = p;
          return disposable;
        },
      },
    },
  } as unknown as PluginContext;
  await activate(ctx);
  const view = {
    id: 'v',
    projectId: 'p',
    visible: true,
    postMessage: post,
    onRequest: (id: string, handler: (p: unknown) => unknown) => {
      requests.set(id, handler);
      return disposable;
    },
    onDidDispose: () => disposable,
    onDidChangeVisibility: (cb: (v: boolean) => void) => {
      visible = cb;
      return disposable;
    },
  } as unknown as PluginView;
  await provider!.resolve(view);
  const pending = Promise.resolve(requests.get('query')!({ view: 'overview' }));
  await vi.waitFor(() => expect(signal).toBeDefined());
  visible!(false);
  await expect(pending).rejects.toThrow('cancelled');
  vi.useFakeTimers();
  try {
    const event: CodeMapChange = { projectId: 'p', checkoutId: 'p', generation: 2, state: 'ready' };
    changed!(event);
    await vi.advanceTimersByTimeAsync(160);
    expect(post).toHaveBeenCalledTimes(1);
    changed!({ ...event, state: 'updating' });
    changed!(event);
    await vi.advanceTimersByTimeAsync(160);
    expect(post).toHaveBeenCalledTimes(1);
    changed!({ ...event, generation: 3 });
    await vi.advanceTimersByTimeAsync(160);
    expect(post).toHaveBeenCalledTimes(2);
    knowledgeChanged!({ projectId: 'other', checkoutId: 'other', memoryRevision: 3 });
    await vi.advanceTimersByTimeAsync(160);
    expect(post).toHaveBeenCalledTimes(2);
    knowledgeChanged!({ projectId: 'p', checkoutId: 'p', memoryRevision: 3 });
    await vi.advanceTimersByTimeAsync(160);
    expect(post).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
    for (const subscription of subscriptions) subscription.dispose();
  }
});
