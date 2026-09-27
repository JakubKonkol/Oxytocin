import { describe, expect, it } from 'vitest';
import type { Project } from '@shared/domain/project';
import { draftOf, move, patchFromDraft, validateDraft } from './project-settings-model';

const project: Project = {
  id: 'p1',
  name: 'api',
  rootPath: '/work/api',
  color: 2,
  pinned: false,
  order: 0,
  createdAt: 0,
  settings: {
    defaultProfileId: 'zsh',
    env: { NODE_ENV: 'development', SECRET: null },
    startupTerminals: [
      { name: 'Dev', command: 'npm run dev', cwd: 'web', placement: 'right' },
      { profileId: 'agent:claude' },
    ],
    editorCommand: 'code -g ${file}:${line}',
    git: { enabled: false, ignoredFolders: ['tmp', 'logs'] },
  },
};

describe('project settings draft', () => {
  it('round-trips a project through the draft unchanged', () => {
    const d = draftOf(project);
    expect(d.env).toEqual([
      { key: 'NODE_ENV', value: 'development', unset: false },
      { key: 'SECRET', value: '', unset: true },
    ]);
    expect(d.ignoredFolders).toBe('tmp\nlogs');
    expect(d.gitEnabled).toBe(false);
    expect(patchFromDraft(project, d)).toEqual({
      id: 'p1',
      name: 'api',
      color: 2,
      icon: null,
      settings: project.settings,
    });
  });

  it('drops empty fields and derives the icon kind', () => {
    const d = {
      ...draftOf({ ...project, settings: {} }),
      icon: '🚀',
      env: [{ key: '  ', value: '', unset: false }],
      startup: [{ name: ' ', profileId: '', command: ' ls ', cwd: '', placement: 'tab' as const }],
      gitEnabled: true,
    };
    const patch = patchFromDraft(project, d);
    expect(patch.icon).toEqual({ kind: 'emoji', value: '🚀' });
    expect(patch.settings).toEqual({ startupTerminals: [{ command: 'ls' }] });
    expect(patchFromDraft(project, { ...d, icon: 'A' }).icon).toEqual({ kind: 'letter', value: 'A' });
  });

  it('validates names, variables and startup folders', () => {
    const d = draftOf(project);
    expect(validateDraft(d)).toEqual([]);
    expect(
      validateDraft({
        ...d,
        name: ' ',
        icon: 'abc',
        env: [
          { key: '1BAD', value: 'x', unset: false },
          { key: 'A', value: '1', unset: false },
          { key: 'A', value: '2', unset: false },
        ],
        startup: [{ name: '', profileId: '', command: '', cwd: '../x', placement: 'tab' }],
      }),
    ).toEqual([
      'The name cannot be empty.',
      'The icon is one letter or one emoji.',
      '"1BAD" is not a valid variable name.',
      'A is defined twice.',
      'Startup terminal 1: the folder must be inside the project (a relative path).',
    ]);
  });

  it('moves list items for drag and drop', () => {
    expect(move(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(move(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });
});
