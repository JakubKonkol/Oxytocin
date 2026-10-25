import type { IDockviewPanelProps } from 'dockview-react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSettings } from '@shared/domain/settings';
import { OxyError } from '@shared/errors';
import { useChangesStore } from '../../stores/changes-store';
import { useSettingsStore } from '../../stores/settings-store';
import { TooltipProvider } from '../../ui/Tooltip';
import { unsavedRegistry } from '../layout/unsaved-registry';
import { DiffPanelComponent } from '../diff/DiffPanel';
import { CodeEditorPanel } from './CodeEditorPanel';
import type { CodePanelParams } from './editor-actions';

const fake = vi.hoisted(() => {
  const disposable = () => ({ dispose() {} });
  const model = (initial: string, language: string) => {
    let text = initial;
    let version = 1;
    let disposed = false;
    const listeners = new Set<() => void>();
    const setValue = (value: string) => {
      text = value;
      version++;
      for (const listener of listeners) listener();
    };
    return {
      getValue: () => text,
      getAlternativeVersionId: () => version,
      getLanguageId: () => language,
      getFullModelRange: () => ({}),
      setValue,
      setEOL() {},
      isDisposed: () => disposed,
      pushEditOperations: (_: unknown, edits: { text: string }[]) => setValue(edits[0]!.text),
      onDidChangeContent: (listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      dispose: () => {
        disposed = true;
        listeners.clear();
      },
    };
  };
  const models: ReturnType<typeof model>[] = [];
  const editor = () => ({
    dispose() {},
    updateOptions() {},
    layout() {},
    saveViewState: () => null,
    onDidContentSizeChange: disposable,
    getContentHeight: () => 100,
  });
  return {
    models,
    disposable,
    createModel: (text: string, language: string) => {
      const created = model(text, language);
      models.push(created);
      return created;
    },
    create: editor,
    createDiffEditor: () => ({
      ...editor(),
      getOriginalEditor: editor,
      getModifiedEditor: editor,
      setModel() {},
      onDidUpdateDiff: disposable,
    }),
  };
});

vi.mock('../diff/monaco-env', () => ({
  ensureTheme: () => 'test',
  addEditorShortcut: fake.disposable,
  monaco: {
    editor: { createModel: fake.createModel, create: fake.create, createDiffEditor: fake.createDiffEditor },
    Uri: { parse: (text: string) => text },
    KeyMod: {},
    KeyCode: {},
  },
}));
vi.mock('../diff/code-actions', () => ({
  attachCodeActions: fake.disposable,
  trackCommentDecorations: fake.disposable,
}));
vi.mock('./editor-actions', () => ({ pendingReveal: new Map(), pinCodePanel() {} }));
vi.mock('../diff/diff-actions', () => ({ pinDiff() {} }));
vi.mock('../../stores/dialog-store', () => ({ confirmDialog: vi.fn().mockResolvedValue(false) }));

const invoke = vi.fn<(channel: string, payload?: unknown) => Promise<unknown>>();
const file = { path: 'a.ts', content: 'original', languageId: 'typescript', mtimeMs: 1, size: 8 };
const diff = {
  path: 'a.ts',
  original: 'HEAD',
  modified: 'original',
  languageId: 'typescript',
  mtimeMs: 1,
  status: 'modified',
};
const props = {
  params: { projectId: 'p', path: 'a.ts', preview: false },
  api: { id: 'panel', setTitle() {}, onDidActiveChange: fake.disposable },
} as unknown as IDockviewPanelProps<CodePanelParams>;

beforeEach(() => {
  fake.models.length = 0;
  invoke.mockReset().mockImplementation((channel) => {
    if (channel === 'files:read') return Promise.resolve(file);
    if (channel === 'git:getFileDiff') return Promise.resolve(diff);
    if (channel === 'files:stat') return Promise.resolve({ mtimeMs: 2, size: 8, isFile: true });
    return Promise.reject(new Error(`Unexpected IPC: ${channel}`));
  });
  (window as unknown as { oxy: unknown }).oxy = { invoke, platform: 'linux' };
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  useSettingsStore.setState({ settings: resolveSettings({}, 'linux').settings });
  useChangesStore.setState({ status: {}, touched: {}, ui: {} });
});
afterEach(() => vi.unstubAllGlobals());

async function open(kind: 'code' | 'diff') {
  render(
    <TooltipProvider>
      {kind === 'code' ? <CodeEditorPanel {...props} /> : <DiffPanelComponent {...props} />}
    </TooltipProvider>,
  );
  await waitFor(() => expect(fake.models.length).toBe(kind === 'code' ? 1 : 2));
  return fake.models.at(-1)!;
}
const writes = () => invoke.mock.calls.filter(([channel]) => channel === 'files:write');

describe('editor persistence', () => {
  it.each(['code', 'diff'] as const)(
    'keeps edits made during a %s save and refuses to close them as saved',
    async (kind) => {
      const model = await open(kind);
      act(() => model.setValue('first edit'));
      const writing = Promise.withResolvers<unknown>();
      invoke.mockImplementationOnce(() => writing.promise);
      let saving!: Promise<boolean>;
      act(() => {
        saving = unsavedRegistry.get('panel')!.save();
      });
      expect(writes()[0]![1]).toMatchObject({ content: 'first edit', expectedMtimeMs: 1 });
      act(() => model.setValue('second edit'));
      expect(unsavedRegistry.get('panel')!.save()).toBe(saving);
      await act(async () => {
        writing.resolve({ mtimeMs: 3, size: 10, isFile: true });
        await saving;
      });
      await expect(saving).resolves.toBe(false);
      expect(model.getValue()).toBe('second edit');
      expect(unsavedRegistry.get('panel')!.isDirty()).toBe(true);
      expect(writes()).toHaveLength(1);
      invoke.mockResolvedValueOnce({ mtimeMs: 4, size: 11, isFile: true });
      await act(async () => {
        expect(await unsavedRegistry.get('panel')!.save()).toBe(true);
      });
      expect(writes()[1]![1]).toMatchObject({ content: 'second edit', expectedMtimeMs: 3 });
      expect(unsavedRegistry.get('panel')!.isDirty()).toBe(false);
    },
  );

  it('keeps an edit made while an automatic disk reload is pending', async () => {
    const model = await open('code');
    const reading = Promise.withResolvers<unknown>();
    invoke.mockImplementation(async (channel) => (channel === 'files:read' ? reading.promise : { mtimeMs: 3 }));
    fireEvent.focus(window);
    await waitFor(() => expect(invoke.mock.calls.filter(([c]) => c === 'files:read')).toHaveLength(2));
    act(() => model.setValue('keep my edit'));
    await act(async () => {
      reading.resolve({ ...file, content: 'external edit', mtimeMs: 2 });
      await reading.promise;
    });
    expect(model.getValue()).toBe('keep my edit');
    expect(screen.getByTestId('code-disk-banner')).toBeVisible();
    expect(unsavedRegistry.get('panel')!.isDirty()).toBe(true);
  });

  it('still checks the original disk version after a live diff refresh notices external edits', async () => {
    const model = await open('diff');
    act(() => model.setValue('my edit'));
    invoke.mockImplementation((channel) => {
      if (channel === 'git:getFileDiff') return Promise.resolve({ ...diff, modified: 'external edit', mtimeMs: 2 });
      return Promise.reject(new OxyError('CONFLICT', 'Changed on disk'));
    });
    act(() => useChangesStore.setState({ touched: { p: { 'a.ts': 123 } } }));
    await screen.findByTestId('diff-disk-banner');
    await act(async () => {
      expect(await unsavedRegistry.get('panel')!.save()).toBe(false);
    });
    expect(writes()[0]![1]).toMatchObject({ expectedMtimeMs: 1 });
    expect(model.getValue()).toBe('my edit');
    expect(unsavedRegistry.get('panel')!.isDirty()).toBe(true);
  });

  it('keeps dirty diff text mounted when the file is deleted externally', async () => {
    const model = await open('diff');
    act(() => model.setValue('recover this text'));
    invoke.mockResolvedValue({ ...diff, modified: null, status: 'deleted', mtimeMs: undefined });
    act(() => useChangesStore.setState({ touched: { p: { 'a.ts': 456 } } }));
    await screen.findByTestId('diff-disk-banner');
    expect(model.isDisposed()).toBe(false);
    expect(model.getValue()).toBe('recover this text');
    expect(unsavedRegistry.get('panel')!.isDirty()).toBe(true);
  });

  it('keeps dirty diff text mounted when a live refresh fails', async () => {
    const model = await open('diff');
    act(() => model.setValue('recover this text'));
    invoke.mockRejectedValue(new Error('Host restarted'));
    act(() => useChangesStore.setState({ touched: { p: { 'a.ts': 789 } } }));
    await screen.findByText('Could not reload the diff: Host restarted');
    expect(model.isDisposed()).toBe(false);
    expect(model.getValue()).toBe('recover this text');
    expect(unsavedRegistry.get('panel')!.isDirty()).toBe(true);
  });

  it('does not apply a previous file save to a replacement diff preview', async () => {
    const view = render(
      <TooltipProvider>
        <DiffPanelComponent {...props} />
      </TooltipProvider>,
    );
    await waitFor(() => expect(fake.models).toHaveLength(2));
    const previous = fake.models.at(-1)!;
    act(() => previous.setValue('first file edit'));
    const writing = Promise.withResolvers<unknown>();
    invoke.mockImplementationOnce(() => writing.promise);
    let saving!: Promise<boolean>;
    act(() => {
      saving = unsavedRegistry.get('panel')!.save();
    });
    invoke.mockResolvedValue({ ...diff, path: 'b.ts', modified: 'second file', mtimeMs: 10 });
    view.rerender(
      <TooltipProvider>
        <DiffPanelComponent {...props} params={{ ...props.params, path: 'b.ts' }} />
      </TooltipProvider>,
    );
    await waitFor(() => expect(fake.models).toHaveLength(4));
    await act(async () => {
      writing.resolve({ mtimeMs: 3, size: 10, isFile: true });
      await saving;
    });
    expect(previous.isDisposed()).toBe(true);
    expect(fake.models.at(-1)!.getValue()).toBe('second file');
    expect(unsavedRegistry.get('panel')!.name).toBe('b.ts');
    expect(unsavedRegistry.get('panel')!.isDirty()).toBe(false);
  });
});
