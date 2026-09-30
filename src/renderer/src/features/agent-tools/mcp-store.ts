import { create } from 'zustand';
import type { McpState } from '@shared/domain/mcp';
import { ipc } from '../../lib/ipc-client';
import { notify } from '../../ui/Toast';
import { openFileLink } from '../terminals/file-link-open';

interface McpStore {
  state: McpState | null;
  load: () => Promise<void>;
}

export const useMcpStore = create<McpStore>((set) => ({
  state: null,
  async load() {
    set({ state: await ipc.invoke('mcp:getState') });
  },
}));

let subscribed = false;
/** State pushes from main, and files agents ask to show (`oxy_open_file`). */
export function subscribeMcp(): void {
  if (subscribed) return;
  subscribed = true;
  ipc.on('mcp:state', (state) => useMcpStore.setState({ state }));
  ipc.on('mcp:openFile', ({ projectId, path, line }) => {
    openFileLink({ path, ...(line ? { line } : {}) }, { projectId, preview: true }).catch((e: unknown) =>
      notify('error', 'Could not open the file', { description: e instanceof Error ? e.message : String(e) }),
    );
  });
}
