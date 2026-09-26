import { fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileChange, RepoStatus } from '@shared/domain/git';
import type { Project } from '@shared/domain/project';
import { DEFAULT_CHANGES_UI, useChangesStore } from '../../stores/changes-store';
import { useProjectsStore } from '../../stores/projects-store';
import { TooltipProvider } from '../../ui/Tooltip';
import { ChangesHeaderActions, ChangesSection } from './ChangesSection';

const invoke = vi.fn((_channel: string, _payload?: unknown): Promise<unknown> => Promise.resolve(null));

const project: Project = {
  id: 'p',
  name: 'api',
  rootPath: '/dev/api',
  color: 0,
  pinned: false,
  order: 0,
  createdAt: 0,
  settings: {},
};

const file = (
  path: string,
  status: FileChange['status'] = 'modified',
  extra: Partial<FileChange> = {},
): FileChange => ({
  path,
  status,
  staged: false,
  unstaged: true,
  additions: 1,
  deletions: 0,
  ...extra,
});

const status = (files: FileChange[], extra: Partial<RepoStatus> = {}): RepoStatus => ({
  projectId: 'p',
  state: 'ok',
  hasHead: true,
  branch: { head: 'main', detached: false, upstream: 'origin/main', ahead: 2, behind: 0 },
  files,
  totals: {
    files: files.length,
    additions: files.reduce((a, f) => a + (f.additions ?? 0), 0),
    deletions: files.reduce((a, f) => a + (f.deletions ?? 0), 0),
  },
  computedAt: 0,
  durationMs: 1,
  ...extra,
});

// jsdom has no layout: give elements a size so the virtualized list renders its rows.
const sizes = { offsetHeight: 600, offsetWidth: 300 };
const saved = Object.fromEntries(
  Object.keys(sizes).map((k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)]),
);
beforeAll(() => {
  for (const [k, v] of Object.entries(sizes))
    Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => v });
});
afterAll(() => {
  for (const [k, d] of Object.entries(saved)) if (d) Object.defineProperty(HTMLElement.prototype, k, d);
});

beforeEach(() => {
  invoke.mockClear();
  (window as unknown as { oxy: unknown }).oxy = { invoke, on: () => () => undefined, platform: 'linux', e2e: false };
  useProjectsStore.setState({ projects: [project], activeId: 'p', loaded: true, activity: {} });
  useChangesStore.setState({ status: {}, touched: {}, ui: {} });
});

const renderSection = () =>
  render(
    <TooltipProvider>
      <ChangesHeaderActions />
      <ChangesSection />
    </TooltipProvider>,
  );

const rowNames = () => screen.queryAllByTestId('changes-row').map((r) => r.getAttribute('data-path'));

describe('ChangesSection', () => {
  it('shows the branch, totals and a compacted tree with status letters', () => {
    useChangesStore.setState({
      status: {
        p: status([
          file('src/features/a.ts', 'modified', { additions: 3, deletions: 1 }),
          file('src/features/b.ts', 'added'),
          file('README.md', 'untracked'),
          file('old.txt', 'deleted', { additions: 0, deletions: 4 }),
        ]),
      },
    });
    renderSection();
    expect(screen.getByTestId('changes-branch')).toHaveTextContent('main');
    expect(screen.getByTestId('changes-totals')).toHaveTextContent(/\+5\s*−5\s*·\s*4 files/);
    expect(rowNames()).toEqual(['src/features', 'src/features/a.ts', 'src/features/b.ts', 'old.txt', 'README.md']);
    const letters = screen.getAllByTestId('changes-status-letter').map((l) => l.textContent);
    expect(letters).toEqual(['M', 'A', 'D', 'U']);
  });

  it('navigates with the keyboard and collapses folders', () => {
    useChangesStore.setState({ status: { p: status([file('src/a.ts'), file('src/b.ts'), file('z.ts')]) } });
    renderSection();
    const tree = screen.getByTestId('changes-tree');
    fireEvent.focus(tree);
    expect(useChangesStore.getState().ui.p?.selected).toBe('src');
    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    expect(rowNames()).toEqual(['src', 'z.ts']);
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    expect(rowNames()).toEqual(['src', 'src/a.ts', 'src/b.ts', 'z.ts']);
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(useChangesStore.getState().ui.p?.selected).toBe('src/b.ts');
    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    expect(useChangesStore.getState().ui.p?.selected).toBe('src');
    fireEvent.keyDown(tree, { key: 'End' });
    expect(useChangesStore.getState().ui.p?.selected).toBe('z.ts');
  });

  it('filters, switches to list mode and collapses all from the header', () => {
    useChangesStore.setState({ status: { p: status([file('src/a.ts'), file('src/deep/b.ts'), file('z.ts')]) } });
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.change(screen.getByTestId('changes-filter'), { target: { value: 'b.ts' } });
    expect(rowNames()).toEqual(['src', 'src/deep', 'src/deep/b.ts']);
    fireEvent.keyDown(screen.getByTestId('changes-filter'), { key: 'Escape' });
    expect(screen.queryByTestId('changes-filter')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'View as list' }));
    expect(rowNames()).toEqual(['src/a.ts', 'src/deep/b.ts', 'z.ts']);
    fireEvent.click(screen.getByRole('button', { name: 'View as tree' }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(rowNames()).toEqual(['src', 'z.ts']);
  });

  it('collapses large change lists by default and shows the truncation banner', () => {
    const files = Array.from({ length: 60 }, (_, i) => file(`dir${i % 3}/f${i}.ts`));
    useChangesStore.setState({ status: { p: status(files, { truncated: { shown: 60, total: 6000 } }) } });
    renderSection();
    expect(rowNames()).toEqual(['dir0', 'dir1', 'dir2']);
    expect(screen.getByTestId('changes-truncated')).toHaveTextContent('Showing 60 of 6,000 changes');
  });

  it('marks recently touched files as live', () => {
    useChangesStore.setState({
      status: { p: status([file('a.ts'), file('b.ts')]) },
      touched: { p: { 'b.ts': Date.now() } },
    });
    renderSection();
    const live = screen.getAllByTestId('changes-live');
    expect(live).toHaveLength(1);
    expect(live[0]!.closest('[data-testid="changes-row"]')).toHaveAttribute('data-path', 'b.ts');
  });

  it.each([
    [{ state: 'not-a-repo' as const }, 'Not a git repository'],
    [{ state: 'git-missing' as const }, 'Git not found'],
    [{ state: 'ok' as const }, 'No changes since HEAD ✓'],
  ])('shows the empty state for %o', (extra, text) => {
    useChangesStore.setState({ status: { p: status([], extra) }, ui: { p: DEFAULT_CHANGES_UI } });
    renderSection();
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});
