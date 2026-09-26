import { createContext, useContext } from 'react';

/** Whether the enclosing project workspace is the visible one (hidden workspaces stay mounted, keep-alive). */
export const WorkspaceVisibleContext = createContext(true);

export const useWorkspaceVisible = () => useContext(WorkspaceVisibleContext);
