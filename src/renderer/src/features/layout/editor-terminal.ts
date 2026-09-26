import { useProjectsStore } from '../../stores/projects-store';
import { workspaceFor } from '../attention/reveal';
import { addTerminalPanel } from './workspace-actions';

/** Terminal editor preset (e.g. `nvim +${line} ${file}`): a new terminal panel running the command. */
export async function openEditorInTerminal(req: {
  projectId: string | null;
  cwd: string;
  command: string;
}): Promise<void> {
  const projectId = req.projectId ?? useProjectsStore.getState().activeId;
  if (!projectId) return;
  const api = await workspaceFor(projectId);
  if (!api) return;
  await addTerminalPanel(api, { projectId, cwd: req.cwd, initialCommand: req.command, userTitle: 'Editor' });
}
