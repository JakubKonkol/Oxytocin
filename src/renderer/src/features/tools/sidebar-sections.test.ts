import { describe, expect, it } from 'vitest';
import { defaultSectionIndex, sidebarSections } from './sidebar-sections';

const usage = {
  pluginId: 'oxytocin.usage-monitor',
  id: 'usage.sidebar',
  slot: 'sidebar' as const,
  title: 'Usage',
  entry: 'dist/views/sidebar.html',
  order: 300,
};

describe('sidebar sections', () => {
  it('lists the core sections and the plugin views in their default order', () => {
    expect(sidebarSections([usage]).map((s) => [s.id, s.title])).toEqual([
      ['projects', 'Projects'],
      ['changes', 'Changes'],
      ['files', 'Files'],
      ['plugin:oxytocin.usage-monitor:usage.sidebar', 'Usage'],
    ]);
  });

  it('puts a re-opened section after the sections that precede it by default', () => {
    const sections = sidebarSections([usage]);
    const usageId = 'plugin:oxytocin.usage-monitor:usage.sidebar';
    expect(defaultSectionIndex('projects', ['changes', 'files', usageId], sections)).toBe(0);
    expect(defaultSectionIndex('files', ['projects', 'changes', usageId], sections)).toBe(2);
    expect(defaultSectionIndex(usageId, ['projects', 'changes'], sections)).toBe(2);
    // Tools in between are skipped over; sections moved by the user keep their place.
    expect(defaultSectionIndex('changes', ['projects', 'tool-1', usageId, 'files'], sections)).toBe(1);
    expect(defaultSectionIndex('changes', [usageId, 'projects'], sections)).toBe(2);
    expect(defaultSectionIndex('changes', [], sections)).toBe(0);
  });
});
