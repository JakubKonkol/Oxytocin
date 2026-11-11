import { describe, expect, it, vi } from 'vitest';
import type { PluginContext, PluginView, ProjectInfo, ViewProvider } from '@oxytocin/plugin-api';
import type { RunnerState } from '../shared/types';
import type { DetectedProfile } from './detect';

/** Scans answered by the test, by project name: a scan of a large project takes as long as the test says. */
const scans = new Map<string, ((profiles: DetectedProfile[]) => void)[]>();
vi.mock('./detect', () => ({
  detectProfiles: (_fs: unknown, options: { rootName: string }) =>
    new Promise<DetectedProfile[]>((resolve) => {
      scans.set(options.rootName, [...(scans.get(options.rootName) ?? []), resolve]);
    }),
}));

const { activate, PANEL_TYPE } = await import('./index');

const profile = (name: string): DetectedProfile => ({
  id: `node:${name}`,
  name,
  command: `npm run ${name}`,
  cwd: '',
  kind: 'node',
});
const finishScans = (project: string, profiles: DetectedProfile[]) => {
  for (const resolve of scans.get(project) ?? []) resolve(profiles);
  scans.delete(project);
};

async function setup() {
  scans.clear();
  const first = { id: 'a', name: 'First', rootPath: '/projects/first' } as ProjectInfo;
  const second = { id: 'b', name: 'Second', rootPath: '/projects/second' } as ProjectInfo;
  let active: ProjectInfo | undefined = first;
  let activeChanged: (p: ProjectInfo | undefined) => void = () => {};
  let listChanged: (list: ProjectInfo[]) => void = () => {};
  const providers = new Map<string, ViewProvider>();
  const subscription = () => ({ dispose: vi.fn() });
  const ctx = {
    subscriptions: [],
    plugin: { version: '0.0.0' },
    storage: { get: () => undefined, set: () => Promise.resolve(), projectDir: (id: string) => `/storage/${id}` },
    log: { warn: vi.fn(), debug: vi.fn() },
    oxy: {
      env: { platform: 'linux' },
      projects: {
        list: () => Promise.resolve([first, second]),
        getActive: () => Promise.resolve(active),
        onDidChange: (handler: typeof listChanged) => {
          listChanged = handler;
          return subscription();
        },
        onDidChangeActive: (handler: typeof activeChanged) => {
          activeChanged = handler;
          return subscription();
        },
      },
      terminals: { list: () => Promise.resolve([]), onDidChange: subscription, onDidClose: subscription },
      settings: { get: () => undefined, onDidChange: subscription },
      ui: {
        statusBarItem: () => ({ hide: vi.fn(), show: vi.fn() }),
        registerPanelProvider: (type: string, provider: ViewProvider) => {
          providers.set(type, provider);
          return subscription();
        },
      },
      commands: { register: subscription },
      mcp: { registerTool: subscription },
    },
  } as unknown as PluginContext;
  await activate(ctx);
  const posted: RunnerState[] = [];
  const requests = new Map<string, (params: unknown) => unknown>();
  // A sidebar view: it follows the active project.
  await providers.get(PANEL_TYPE)!.resolve({
    visible: false,
    postMessage: (message: RunnerState) => {
      posted.push(message);
      return Promise.resolve(true);
    },
    onDidDispose: vi.fn(),
    onDidChangeVisibility: vi.fn(),
    onRequest: (method: string, handler: (params: unknown) => unknown) => requests.set(method, handler),
  } as unknown as PluginView);
  return {
    first,
    second,
    posted,
    load: () => requests.get('load')!(undefined) as Promise<RunnerState>,
    projectsChanged: () => listChanged([first, second]),
    activate: (project: ProjectInfo) => {
      active = project;
      activeChanged(project);
    },
    dispose: () => ctx.subscriptions.forEach((d) => d.dispose()),
  };
}

const names = (state: RunnerState | undefined) => state?.profiles.map((p) => p.name);

describe('Run view state', () => {
  it('never shows the previous project again when its scan finishes after the switch', async () => {
    const s = await setup();
    try {
      // The first project is being scanned (a large folder) when the user opens another project.
      s.projectsChanged();
      await vi.waitFor(() => expect(scans.has('First')).toBe(true));
      s.activate(s.second);
      await vi.waitFor(() => expect(scans.has('Second')).toBe(true));
      finishScans('Second', []);
      await vi.waitFor(() => expect(s.posted.at(-1)).toMatchObject({ project: { id: 'b' }, scanning: false }));
      finishScans('First', [profile('dev')]);
      // The first project's update is dropped; a rejected message would show up here.
      await new Promise((resolve) => setImmediate(resolve));
      expect(s.posted.at(-1)).toMatchObject({ project: { id: 'b' }, profiles: [] });
      expect(s.posted.some((state) => state.project?.id === 'a' && state.profiles.length > 0)).toBe(false);
      // Back in the first project its profiles are shown.
      s.activate(s.first);
      await vi.waitFor(() => expect(names(s.posted.at(-1))).toEqual(['dev']));
    } finally {
      s.dispose();
    }
  });

  it('answers a view that loads during a project switch with the project it shows now', async () => {
    const s = await setup();
    try {
      const loading = s.load();
      await vi.waitFor(() => expect(scans.has('First')).toBe(true));
      s.activate(s.second);
      await vi.waitFor(() => expect(scans.has('Second')).toBe(true));
      finishScans('First', [profile('dev')]);
      finishScans('Second', [profile('api')]);
      const loaded = await loading;
      expect(loaded.project?.id).toBe('b');
      expect(names(loaded)).toEqual(['api']);
    } finally {
      s.dispose();
    }
  });
});
