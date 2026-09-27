import { describe, expect, it } from 'vitest';
import { applyUiStatePatch, defaultUiState, SCRATCHPAD_MAX_LENGTH, UiStateSchema } from './ui-state';

describe('ui state', () => {
  it('defaults the right sidebar and scratchpad for files written by older versions', () => {
    const { secondarySidebar, secondaryPaneview, scratchpad, ...older } = defaultUiState();
    const parsed = UiStateSchema.parse(older);
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

  it('caps the scratchpad size', () => {
    expect(UiStateSchema.shape.scratchpad.safeParse({ text: 'x'.repeat(SCRATCHPAD_MAX_LENGTH + 1) }).success).toBe(
      false,
    );
  });
});
