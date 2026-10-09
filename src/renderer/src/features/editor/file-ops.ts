import { ipc } from '../../lib/ipc-client';
import { confirmDialog, confirmDialogEx } from '../../stores/dialog-store';
import { notify } from '../../ui/Toast';
import { getWorkspaceApi } from '../layout/workspace-registry';
import { codeRegistry } from './code-registry';
import { type CodePanelParams, openFile } from './editor-actions';
import { ancestors, useFilesStore } from './files-store';

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const report = (what: string) => (e: unknown) =>
  notify('error', what, { description: e instanceof Error ? e.message : String(e) });

/** A typed name → a relative path ('a/b.ts' creates folders on the way); null when it is not a valid name. */
export function cleanName(input: string): string | null {
  const parts = input
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p === '.' || p === '..' || /[<>:"|?*\0]/.test(p))) return null;
  return parts.join('/');
}

/** "New File…" / "New Folder…" in a folder of the project; a new file opens in the editor. */
export async function newEntry(projectId: string, dir: string, kind: 'file' | 'dir'): Promise<void> {
  const r = await confirmDialogEx({
    title: kind === 'file' ? 'New file' : 'New folder',
    description: dir ? `In ${dir}/` : 'In the project folder. Use / to create folders on the way.',
    input: { kind: 'text', placeholder: kind === 'file' ? 'name.ts' : 'folder', singleLine: true },
    confirmLabel: 'Create',
  });
  if (!r.confirmed || !r.value) return;
  const name = cleanName(r.value);
  if (!name) {
    notify('error', `"${r.value}" is not a valid name`);
    return;
  }
  const path = join(dir, name);
  try {
    await ipc.invoke('files:create', { projectId, path, kind });
  } catch (e) {
    report(`Could not create ${name}`)(e);
    return;
  }
  // Show it: the folder it was created in, and the folders created on the way, expanded.
  const store = useFilesStore.getState();
  await store.load(projectId, dir);
  for (const folder of [dir, ...ancestors(path).filter((a) => a.length > dir.length)]) {
    if (!folder) continue;
    store.setExpanded(projectId, folder, true);
    await store.load(projectId, folder);
  }
  store.select(projectId, path);
  if (kind === 'file') openFile(projectId, path, { pinned: true });
}

/** Renames a file or folder; open editors of it follow the new name. */
export async function renameEntry(projectId: string, path: string): Promise<void> {
  const name = path.split('/').at(-1) ?? path;
  const r = await confirmDialogEx({
    title: `Rename ${name}`,
    input: { kind: 'text', value: name, singleLine: true },
    confirmLabel: 'Rename',
  });
  if (!r.confirmed || !r.value || r.value === name) return;
  const next = cleanName(r.value);
  if (!next) {
    notify('error', `"${r.value}" is not a valid name`);
    return;
  }
  const to = join(parentOf(path), next);
  try {
    await ipc.invoke('files:rename', { projectId, from: path, to });
  } catch (e) {
    report(`Could not rename ${name}`)(e);
    return;
  }
  // Editors of the file (or of files inside the folder) follow it.
  const api = getWorkspaceApi(projectId);
  for (const panel of api?.panels ?? []) {
    if (panel.api.component !== 'code') continue;
    const params = panel.params as CodePanelParams;
    if (params.path === path || params.path.startsWith(`${path}/`)) {
      if (codeRegistry.get(panel.id)?.isDirty()) continue;
      panel.api.updateParameters({ ...params, path: to + params.path.slice(path.length) });
    }
  }
  const store = useFilesStore.getState();
  await store.refresh(projectId);
  store.select(projectId, to);
}

/** Moves a file or folder to the trash (asks first). */
export async function deleteEntry(projectId: string, path: string, kind: 'file' | 'dir'): Promise<void> {
  const name = path.split('/').at(-1) ?? path;
  const ok = await confirmDialog({
    title: `Delete ${name}?`,
    description: `The ${kind === 'dir' ? 'folder and everything in it' : 'file'} goes to the trash.`,
    confirmLabel: 'Move to trash',
    destructive: true,
  });
  if (!ok) return;
  try {
    await ipc.invoke('files:trash', { projectId, path });
  } catch (e) {
    report(`Could not delete ${name}`)(e);
    return;
  }
  await useFilesStore.getState().load(projectId, parentOf(path));
}
