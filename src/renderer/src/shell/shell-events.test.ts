import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executeCommand = vi.fn(() => Promise.resolve(undefined));
const runCoreCommand = vi.fn();
vi.mock('../lib/commands', () => ({ executeCommand }));
vi.mock('../features/layout/core-commands', () => ({
  runCoreCommand,
  openPluginTerminal: vi.fn(),
  closePluginTerminalPanel: vi.fn(),
}));
const dismissNotification = vi.fn();
vi.mock('../features/attention/attention', () => ({ showNotification: vi.fn(), dismissNotification }));
vi.mock('../features/attention/reveal', () => ({ revealTerminal: vi.fn() }));
vi.mock('../features/layout/editor-terminal', () => ({ openEditorInTerminal: vi.fn() }));
vi.mock('../ui/Toast', () => ({ notify: vi.fn() }));

const { subscribeShellEvents } = await import('./shell-events');

type Listener = (payload: unknown) => void;
let listeners: Map<string, Set<Listener>>;

const emit = (channel: string, payload: unknown) => {
  for (const l of listeners.get(channel) ?? []) l(payload);
};

beforeEach(() => {
  listeners = new Map();
  (window as unknown as { oxy: unknown }).oxy = {
    on: (channel: string, listener: Listener) => {
      const set = listeners.get(channel) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(channel, set);
      return () => set.delete(listener);
    },
  };
});

afterEach(() => vi.clearAllMocks());

describe('subscribeShellEvents', () => {
  it('runs menu commands from main', () => {
    const dispose = subscribeShellEvents();
    emit('app:menuCommand', { command: 'workbench.openSettings' });
    expect(executeCommand).toHaveBeenCalledWith('workbench.openSettings');
    dispose();
  });

  it('closes toasts that main withdrew', () => {
    const dispose = subscribeShellEvents();
    emit('notifications:dismiss', { requestId: 'r1' });
    expect(dismissNotification).toHaveBeenCalledWith('r1');
    dispose();
  });

  it('ignores commands the menu does not offer', () => {
    const dispose = subscribeShellEvents();
    emit('app:menuCommand', { command: 'terminal.new' });
    expect(executeCommand).not.toHaveBeenCalled();
    dispose();
  });

  it('delivers each event once after a StrictMode remount and nothing after unsubscribing', () => {
    subscribeShellEvents()();
    const dispose = subscribeShellEvents();
    emit('commands:run', { id: 'oxytocin.terminal.new', args: [] });
    expect(runCoreCommand).toHaveBeenCalledTimes(1);
    dispose();
    emit('commands:run', { id: 'oxytocin.terminal.new', args: [] });
    expect(runCoreCommand).toHaveBeenCalledTimes(1);
    expect([...listeners.values()].every((s) => s.size === 0)).toBe(true);
  });
});
