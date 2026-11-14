import { describe, expect, it } from 'vitest';
import { fitPaneSizes, type PaneBox } from './pane-sizes';

const pane = (id: string, size: number, expanded = true, min = 110): PaneBox => ({ id, size, expanded, min });

describe('fitPaneSizes', () => {
  it('gives the sections their saved heights when they fit exactly', () => {
    // Added one by one, dockview left the first sections small and the last one with the rest.
    const panes = [pane('projects', 110), pane('changes', 110), pane('usage', 580)];
    expect(fitPaneSizes(panes, { projects: 200, changes: 450, usage: 150 }, 800)).toEqual([200, 450, 150]);
  });

  it('keeps the proportions when the sidebar is taller or shorter than when they were saved', () => {
    const panes = [pane('projects', 300), pane('changes', 300), pane('usage', 400)];
    expect(fitPaneSizes(panes, { projects: 200, changes: 400, usage: 200 }, 1000)).toEqual([250, 500, 250]);
    expect(fitPaneSizes(panes, { projects: 200, changes: 400, usage: 200 }, 600)).toEqual([150, 300, 150]);
  });

  it('leaves collapsed sections at their header height and fits the others into the rest', () => {
    const panes = [pane('projects', 200), pane('files', 30, false, 30), pane('changes', 570)];
    expect(fitPaneSizes(panes, { projects: 300, files: 500, changes: 500 }, 800)).toEqual([289, 30, 481]);
  });

  it('keeps the minimum height of every section, taking the difference from the others', () => {
    const panes = [pane('projects', 300), pane('changes', 300), pane('usage', 300)];
    const sizes = fitPaneSizes(panes, { projects: 20, changes: 2000, usage: 20 }, 900)!;
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(900);
    expect(sizes[0]).toBe(110);
    expect(sizes[2]).toBe(110);
  });

  it('uses the current height of a section never sized by the user', () => {
    const panes = [pane('projects', 300), pane('new', 200)];
    expect(fitPaneSizes(panes, { projects: 300 }, 500)).toEqual([300, 200]);
  });

  it('adds up to the total despite rounding', () => {
    const panes = [pane('a', 100, true, 10), pane('b', 100, true, 10), pane('c', 100, true, 10)];
    const sizes = fitPaneSizes(panes, { a: 1, b: 1, c: 1 }, 301)!;
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(301);
  });

  it('does nothing without room or without an expanded section', () => {
    expect(fitPaneSizes([pane('a', 30, false, 30)], {}, 500)).toBeNull();
    expect(fitPaneSizes([pane('a', 200), pane('b', 200)], {}, 100)).toBeNull();
    expect(fitPaneSizes([pane('a', 200)], {}, 0)).toBeNull();
  });
});
