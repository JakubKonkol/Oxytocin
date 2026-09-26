import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@shared/domain/project';
import { useProjectsStore } from '../../stores/projects-store';
import { useTerminalsStore } from '../../stores/terminals-store';
import { TooltipProvider } from '../../ui/Tooltip';
import { ProjectsSection } from './ProjectsSection';
import { projectDotState } from './project-dot';

const invoke = vi.fn((channel: string, _payload?: unknown): Promise<unknown> => {
  if (channel === 'projects:add') return Promise.resolve({ project: {}, existed: false });
  return Promise.resolve(undefined);
});

const project = (id: string, name: string, extra: Partial<Project> = {}): Project => ({
  id,
  name,
  rootPath: `/dev/${name}`,
  color: 1,
  pinned: false,
  order: 0,
  createdAt: 0,
  settings: {},
  ...extra,
});

beforeEach(() => {
  invoke.mockClear();
  (window as unknown as { oxy: unknown }).oxy = {
    invoke,
    on: () => () => undefined,
    getPathForFile: (f: File) => `/dropped/${f.name}`,
    platform: 'linux',
    e2e: false,
  };
  useTerminalsStore.setState({ terminals: {}, loaded: true });
});

const renderSection = () =>
  render(
    <TooltipProvider>
      <ProjectsSection />
    </TooltipProvider>,
  );

describe('ProjectsSection', () => {
  it('shows an empty state with an add button', () => {
    useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
    renderSection();
    expect(screen.getByText('No projects yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add project/ })).toBeInTheDocument();
  });

  it('lists projects and marks the active one', () => {
    useProjectsStore.setState({
      projects: [project('a', 'api'), project('b', 'web', { missing: true })],
      activeId: 'a',
      loaded: true,
    });
    renderSection();
    const api = screen.getByTestId('projects-item-api');
    expect(api).toHaveAttribute('aria-selected', 'true');
    expect(api).toHaveTextContent('ACTIVE');
    expect(screen.getByLabelText('Folder not found')).toBeInTheDocument();
  });

  it('activates a project on click', () => {
    useProjectsStore.setState({ projects: [project('a', 'api'), project('b', 'web')], activeId: 'a', loaded: true });
    renderSection();
    fireEvent.click(screen.getByTestId('projects-item-web'));
    expect(invoke).toHaveBeenCalledWith('projects:setActive', { id: 'b' });
    expect(useProjectsStore.getState().activeId).toBe('b');
  });

  it('adds dropped folders', async () => {
    useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
    renderSection();
    const file = new File([''], 'my-folder');
    fireEvent.drop(screen.getByTestId('projects-dropzone'), { dataTransfer: { types: ['Files'], files: [file] } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('projects:add', { path: '/dropped/my-folder' }));
  });

  it('renames inline on double click', async () => {
    useProjectsStore.setState({ projects: [project('a', 'api')], activeId: 'a', loaded: true });
    renderSection();
    fireEvent.doubleClick(screen.getByText('api'));
    const input = screen.getByTestId('project-rename-input');
    fireEvent.change(input, { target: { value: 'Backend' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('projects:update', { id: 'a', name: 'Backend' }));
  });
});

describe('projectDotState', () => {
  const t = (over: object) => ({ state: 'running', kind: 'shell', exitCode: undefined, ...over }) as never;
  it('aggregates terminal states', () => {
    expect(projectDotState([])).toBe('none');
    expect(projectDotState([t({})])).toBe('idle');
    expect(projectDotState([t({}), t({ kind: 'process' })])).toBe('running');
    expect(projectDotState([t({ kind: 'process' }), t({ kind: 'agent' })])).toBe('agent-working');
    expect(projectDotState([t({ kind: 'agent' }), t({ state: 'exited', exitCode: 3 })])).toBe('error');
  });
});
