import { describe, expect, it } from 'vitest';
import { applyUiStatePatch, defaultUiState, SCRATCHPAD_MAX_LENGTH, UiStateSchema } from './ui-state';

describe('ui state', () => {
  it('defaults the right sidebar and scratchpad for files written by older versions', () => {
    const { secondarySidebar, secondaryPaneview, secondaryTools, scratchpad, ...older } = defaultUiState();
    const parsed = UiStateSchema.parse(older);
    expect(parsed.secondaryTools).toEqual(secondaryTools);
    expect(parsed.secondaryTools).toEqual([{ id: 'scratchpad', kind: 'scratchpad' }]);
    expect(parsed.secondarySidebar).toEqual(secondarySidebar);
    expect(parsed.secondaryPaneview).toEqual(secondaryPaneview);
    expect(parsed.scratchpad).toEqual(scratchpad);
  });

  it('merges right sidebar patches and replaces the scratchpad text', () => {
    let state = applyUiStatePatch(defaultUiState(), { secondarySidebar: { collapsed: true } });
    state = applyUiStatePatch(state, { secondarySidebar: { width: 400 }, scratchpad: { text: 'draft' } });
    expect(state.secondarySidebar).toEqual({ width: 400, collapsed: true });
    expect(state.scratchpad.text).toBe('draft');
    expect(() => applyUiStatePatch(state, { secondarySidebar: { width: 5 } })).toThrow();
  });

  it('keeps the right sidebar tools, including closing all of them', () => {
    const tool = {
      id: 'tool-1',
      kind: 'plugin' as const,
      pluginId: 'oxytocin.json-formatter',
      panelType: 'json.formatter',
      viewId: 'pv-1',
    };
    let state = applyUiStatePatch(defaultUiState(), { secondaryTools: [tool] });
    expect(UiStateSchema.parse(state).secondaryTools).toEqual([tool]);
    state = applyUiStatePatch(state, { secondaryTools: [] });
    expect(UiStateSchema.parse(state).secondaryTools).toEqual([]);
    expect(UiStateSchema.shape.secondaryTools.safeParse([{ id: 'x', kind: 'terminal' }]).success).toBe(false);
  });

  it('keeps the left sidebar tools; files of older versions have none', () => {
    const { primaryTools: _none, ...older } = defaultUiState();
    expect(UiStateSchema.parse(older).primaryTools).toEqual([]);
    const tool = {
      id: 'tool-2',
      kind: 'plugin' as const,
      pluginId: 'oxytocin.project-runner',
      panelType: 'projectRunner.panel',
      viewId: 'pv-2',
    };
    const state = applyUiStatePatch(defaultUiState(), { primaryTools: [tool] });
    expect(UiStateSchema.parse(state).primaryTools).toEqual([tool]);
    expect(state.secondaryTools).toEqual(defaultUiState().secondaryTools);
  });

  it('caps the scratchpad size', () => {
    expect(UiStateSchema.shape.scratchpad.safeParse({ text: 'x'.repeat(SCRATCHPAD_MAX_LENGTH + 1) }).success).toBe(
      false,
    );
  });
});
