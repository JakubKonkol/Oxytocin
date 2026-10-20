import type { PluginContext, PluginView, CodeMapLocator } from '@oxytocin/plugin-api';
import { z } from 'zod';
import { SelectionSchema } from '../shared/model';

export async function activate(ctx: PluginContext): Promise<void> {
  const { oxy } = ctx;
  const views = new Map<PluginView, { controller?: AbortController; timer?: ReturnType<typeof setTimeout> }>();
  const checkpoints = new Map<string, string>();
  let active = await oxy.projects.getActive();
  const projectOf = (view: PluginView) => view.projectId ?? active?.id;
  const cancel = (view: PluginView) => {
    const state = views.get(view);
    state?.controller?.abort();
    if (state?.timer) clearTimeout(state.timer);
  };
  const invalidate = (view: PluginView) => {
    cancel(view);
    const state = views.get(view);
    if (state && view.visible)
      state.timer = setTimeout(() => {
        void view.postMessage({ type: 'invalidate', projectId: projectOf(view) });
      }, 150);
  };
  ctx.subscriptions.push(
    oxy.commands.register('codeMap.open', async (raw) => {
      const projectId = typeof raw === 'string' ? raw : (await oxy.projects.getActive())?.id;
      await oxy.ui.openPanel('codeMap.view', projectId ? { projectId } : {});
    }),
    oxy.projects.onDidChangeActive((project) => {
      active = project;
      for (const view of views.keys())
        if (!view.projectId) {
          cancel(view);
          void view.postMessage({ type: 'reset', projectId: project?.id });
        }
    }),
    oxy.codeMap.onDidChange((change) => {
      // Metadata audits requested by a reader also publish progress; they must not trigger a refresh loop.
      if (change.state === 'updating' || change.state === 'indexing') return;
      const key = `${change.generation}:${change.state}`;
      if (checkpoints.get(change.checkoutId) === key) return;
      checkpoints.set(change.checkoutId, key);
      for (const view of views.keys()) if (projectOf(view) === change.projectId) invalidate(view);
    }),
    oxy.ui.registerPanelProvider('codeMap.view', {
      resolve(view) {
        const state: { controller?: AbortController; timer?: ReturnType<typeof setTimeout> } = {};
        views.set(view, state);
        view.onDidDispose(() => {
          cancel(view);
          views.delete(view);
        });
        view.onDidChangeVisibility((visible) => {
          cancel(view);
          if (visible) invalidate(view);
        });
        view.onRequest('cancel', () => {
          cancel(view);
          return null;
        });
        view.onRequest('model', async () => {
          const projectId = projectOf(view);
          const project = (await oxy.projects.list()).find((p) => p.id === projectId);
          return {
            project: project ? { id: project.id, name: project.name } : null,
            checkouts: projectId ? await oxy.codeMap.listCheckouts(projectId) : [],
          };
        });
        view.onRequest('query', async (input: unknown) => {
          const selection = SelectionSchema.parse(input),
            projectId = projectOf(view);
          if (!projectId) throw new Error('Open a project first.');
          cancel(view);
          const controller = new AbortController();
          state.controller = controller;
          const checkout = (await oxy.codeMap.listCheckouts(projectId)).find((c) => c.mode === 'project');
          controller.signal.throwIfAborted();
          if (!checkout) throw new Error('Enable Code Map in project settings.');
          const ref = { projectId, checkoutId: checkout.checkoutId };
          const response = await oxy.codeMap.query(
            selection.view === 'search'
              ? { ...ref, kind: 'search', query: selection.query, limit: 50, maxChars: 24000 }
              : {
                  ...ref,
                  kind: 'slice',
                  view: selection.view,
                  root: selection.root,
                  generation: selection.generation,
                  direction: selection.direction,
                  relations: selection.relations,
                  depth: selection.depth,
                  includeHeuristic: selection.includeHeuristic,
                },
            { signal: controller.signal },
          );
          controller.signal.throwIfAborted();
          if (projectOf(view) !== projectId) throw new Error('Project changed.');
          return { projectId, response };
        });
        view.onRequest('open', async (raw: unknown) => {
          const input = z
            .object({
              checkoutId: z.string(),
              path: z.string(),
              sha256: z.string(),
              generation: z.number(),
              symbolId: z.string().optional(),
              span: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
            })
            .strict()
            .parse(raw);
          const projectId = projectOf(view);
          if (!projectId) throw new Error('Open a project first.');
          await oxy.codeMap.openSource({ ...input, projectId } satisfies CodeMapLocator);
          return null;
        });
      },
    }),
    {
      dispose() {
        for (const view of views.keys()) cancel(view);
        views.clear();
      },
    },
  );
}
