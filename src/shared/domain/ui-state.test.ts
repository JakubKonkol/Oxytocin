import { describe, expect, it } from 'vitest';
import {
  applyUiStatePatch,
  defaultScratchpad,
  defaultUiState,
  otherScratchpadsWithText,
  SCRATCHPAD_MAX_LENGTH,
  scratchpadText,
  UiStateSchema,
  withScratchpadShared,
  withScratchpadText,
} from './ui-state';

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
    state = applyUiStatePatch(state, {
      secondarySidebar: { width: 400 },
      scratchpad: { text: 'draft', shared: true, projects: {} },
    });
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

  it('reads scratchpads of older versions as one shared scratchpad', () => {
    const parsed = UiStateSchema.parse({ ...defaultUiState(), scratchpad: { text: 'old notes' } });
    expect(parsed.scratchpad).toEqual({ text: 'old notes', shared: true, projects: {} });
    expect(scratchpadText(parsed.scratchpad, 'p1')).toBe('old notes');
  });

  it('keeps one scratchpad per project when sharing is off', () => {
    let s = withScratchpadText(defaultScratchpad(), 'p1', 'shared notes');
    expect(scratchpadText(s, 'p2')).toBe('shared notes');
    // Off: the current project keeps what it shows, the others start empty.
    s = withScratchpadShared(s, false, 'p1');
    expect(scratchpadText(s, 'p1')).toBe('shared notes');
    expect(scratchpadText(s, 'p2')).toBe('');
    s = withScratchpadText(s, 'p2', 'api todo');
    s = withScratchpadText(s, 'p1', 'web todo');
    expect([scratchpadText(s, 'p1'), scratchpadText(s, 'p2')]).toEqual(['web todo', 'api todo']);
    // Without a project the shared text is edited.
    expect(scratchpadText(s, null)).toBe('shared notes');
    // Clearing a project's scratchpad drops its entry; closed projects are pruned.
    s = withScratchpadText(s, 'p2', '', ['p1', 'p2']);
    expect(s.projects).toEqual({ p1: 'web todo' });
    s = withScratchpadText({ ...s, projects: { ...s.projects, gone: 'x' } }, 'p1', 'web', ['p1']);
    expect(s.projects).toEqual({ p1: 'web' });
    expect(UiStateSchema.shape.scratchpad.parse(s)).toEqual(s);
  });

  it("shares the current project's scratchpad and reports what that replaces", () => {
    let s = withScratchpadShared(defaultScratchpad(), false, 'p1');
    s = withScratchpadText(s, 'p1', 'mine');
    expect(otherScratchpadsWithText(s, 'p1')).toEqual([]);
    s = withScratchpadText(s, 'p2', 'theirs');
    s = withScratchpadText(s, 'p3', '   ');
    expect(otherScratchpadsWithText(s, 'p1')).toEqual(['p2']);
    expect(otherScratchpadsWithText(s, 'p1', ['p1'])).toEqual([]);
    s = withScratchpadShared(s, true, 'p1');
    expect(s).toEqual({ text: 'mine', shared: true, projects: {} });
    expect(otherScratchpadsWithText(s, 'p1')).toEqual([]);
    expect(withScratchpadText(s, 'p1', 'x'.repeat(SCRATCHPAD_MAX_LENGTH + 5)).text).toHaveLength(SCRATCHPAD_MAX_LENGTH);
  });
});
