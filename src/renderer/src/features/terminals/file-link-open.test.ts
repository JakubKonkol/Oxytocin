import { describe, expect, it } from 'vitest';
import { chooseFileLinkTarget } from './file-link-open';

const opener = (id: string, isDefault = false) => ({
  id,
  pluginId: 'oxytocin.markdown-preview',
  extensions: ['.md'],
  panelType: 'markdown.preview',
  title: 'Open Preview',
  default: isDefault,
});

describe('chooseFileLinkTarget', () => {
  const base = { projectRoot: '/p/app', caseInsensitive: false };

  it('opens project files with the default opener when previews are wanted', () => {
    const choice = chooseFileLinkTarget('/p/app/CLAUDE.md', {
      ...base,
      preview: true,
      openers: [opener('other'), opener('md', true)],
    });
    expect(choice).toMatchObject({ kind: 'preview', opener: { id: 'md' } });
    expect(chooseFileLinkTarget('/p/app/a.md', { ...base, preview: true, openers: [opener('only')] })).toMatchObject({
      kind: 'preview',
      opener: { id: 'only' },
    });
  });

  it('falls back to the editor', () => {
    const openers = [opener('md', true)];
    expect(chooseFileLinkTarget('/p/app/a.md', { ...base, preview: false, openers })).toEqual({ kind: 'editor' });
    expect(chooseFileLinkTarget('/elsewhere/a.md', { ...base, preview: true, openers })).toEqual({ kind: 'editor' });
    expect(chooseFileLinkTarget('/p/app/a.bin', { ...base, preview: true, openers: [] })).toEqual({ kind: 'editor' });
    expect(
      chooseFileLinkTarget('/p/app/a.md', { preview: true, projectRoot: undefined, openers, caseInsensitive: false }),
    ).toEqual({ kind: 'editor' });
  });
});
