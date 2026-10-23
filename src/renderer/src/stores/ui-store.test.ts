import { describe, expect, it, vi } from 'vitest';

const invoke = vi.fn((_channel: string, _payload?: unknown) => Promise.resolve(undefined));
vi.mock('../lib/ipc-client', () => ({ ipc: { invoke } }));

describe('flushUiState', () => {
  it("sends a component's delayed write together with the pending changes when quitting", async () => {
    const { flushUiState, onUiFlush, useUiStore } = await import('./ui-store');
    const layout = { order: ['changes'], collapsed: ['changes'], hidden: [], sizes: {} };
    const off = onUiFlush(() => useUiStore.getState().setPaneview(layout));
    await flushUiState();
    expect(invoke).toHaveBeenCalledWith('ui:patchState', expect.objectContaining({ paneview: layout }));
    off();
    invoke.mockClear();
    await flushUiState();
    expect(invoke).not.toHaveBeenCalled();
  });
});
