import { ipc } from '../../lib/ipc-client';
import { currentPlatform } from '../../lib/platform';
import { useProjectsStore } from '../../stores/projects-store';
import { notify } from '../../ui/Toast';
import { fileOpenersFor, openWithOpener } from '../plugins/plugin-commands';
import { isInsideRoot } from './file-links';
import type { FileLinkTarget } from './link-provider';

type Opener = ReturnType<typeof fileOpenersFor>[number];

/**
 * Where a file link goes: the preview (a plugin file opener, preferring a `default` one) when previews are wanted and
 * the file belongs to the terminal's project, else the editor.
 */
export function chooseFileLinkTarget(
  path: string,
  o: { preview: boolean; projectRoot?: string | undefined; openers: Opener[]; caseInsensitive: boolean },
): { kind: 'preview'; opener: Opener } | { kind: 'editor' } {
  if (!o.preview || !o.projectRoot || !isInsideRoot(o.projectRoot, path, o.caseInsensitive)) return { kind: 'editor' };
  const opener = o.openers.find((x) => x.default) ?? o.openers[0];
  return opener ? { kind: 'preview', opener } : { kind: 'editor' };
}

/** Ctrl/⌘+click on a file link (`terminal.fileLinks.open`; Shift inverts it). */
export async function openFileLink(
  target: FileLinkTarget,
  o: { projectId: string | undefined; preview: boolean },
): Promise<void> {
  const project = o.projectId ? useProjectsStore.getState().projects.find((p) => p.id === o.projectId) : undefined;
  const choice = chooseFileLinkTarget(target.path, {
    preview: o.preview,
    projectRoot: project?.rootPath,
    openers: fileOpenersFor(target.path),
    caseInsensitive: currentPlatform() !== 'linux',
  });
  try {
    if (choice.kind === 'preview' && project) {
      await openWithOpener(choice.opener, project.id, target.path, {
        ...(target.line ? { line: target.line } : {}),
        ...(target.column ? { column: target.column } : {}),
      });
    } else await ipc.invoke('editor:open', target);
  } catch (e) {
    notify('error', 'Could not open the file', { description: e instanceof Error ? e.message : String(e) });
  }
}
