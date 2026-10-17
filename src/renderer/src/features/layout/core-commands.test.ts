import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const group = { id: 'original' };
  const moveTo = vi.fn();
  const panel = { params: { terminalId: 'terminal' }, group, api: { moveTo } };
  const api = { activeGroup: group, panels: [] as (typeof panel)[], getPanel: () => panel };
  return { api, group, panel, moveTo, reveal: vi.fn(), add: vi.fn() };
});
vi.mock('../../lib/commands', () => ({ executeCommand: vi.fn() }));
vi.mock('../../stores/terminals-store', () => ({ useTerminalsStore: { getState: () => ({ terminals: {} }) } }));
vi.mock('../attention/reveal', () => ({
  revealTerminal: mocks.reveal,
  workspaceFor: () => Promise.resolve(mocks.api),
}));
vi.mock('../diff/diff-actions', () => ({ openDiff: vi.fn() }));
vi.mock('../projects/project-actions', () => ({ activateProject: vi.fn() }));
vi.mock('./workspace-actions', () => ({ addExistingTerminalPanel: mocks.add }));
vi.mock('./workspace-registry', () => ({ getWorkspaceApi: () => mocks.api }));
import { openPluginTerminal } from './core-commands';

describe('plugin terminal placement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.panels = [];
    mocks.api.activeGroup = mocks.group;
    mocks.add.mockImplementation(() => {
      mocks.api.panels.push(mocks.panel);
      return 'panel';
    });
  });
  it('splits a new terminal to the right of the active group and reveals it', async () => {
    await openPluginTerminal({ terminalId: 'terminal', projectId: 'project', placement: 'right', focus: true });
    expect(mocks.moveTo).toHaveBeenCalledWith({ group: mocks.group, position: 'right' });
    expect(mocks.reveal).toHaveBeenCalledWith('project', 'terminal');
  });
  it('reveals a reused terminal without adding or moving its panel', async () => {
    mocks.api.panels = [mocks.panel];
    await openPluginTerminal({ terminalId: 'terminal', projectId: 'project', placement: 'right', focus: true });
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.moveTo).not.toHaveBeenCalled();
    expect(mocks.reveal).toHaveBeenCalledWith('project', 'terminal');
  });
});
