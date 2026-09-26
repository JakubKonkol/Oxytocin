import { useEffect } from 'react';
import { DEFAULT_PROJECT_ID } from '@shared/domain/terminal';
import { ipc } from '../../lib/ipc-client';
import { useTerminalsStore } from '../../stores/terminals-store';
import { EmptyState } from '../../ui/EmptyState';
import { TerminalView } from './TerminalView';

let creating: Promise<unknown> | null = null;

/**
 * Temporary center area (M1): one terminal of the default project. Replaced by the dockview workspace in M2.
 * After a renderer reload it re-attaches to the existing terminal instead of creating a new one.
 */
export function DefaultTerminalArea() {
  const loaded = useTerminalsStore((s) => s.loaded);
  const terminal = useTerminalsStore((s) => Object.values(s.terminals).find((t) => t.projectId === DEFAULT_PROJECT_ID));

  useEffect(() => {
    if (!loaded || terminal || creating) return;
    creating = ipc
      .invoke('terminals:create', { projectId: DEFAULT_PROJECT_ID })
      .then((info) => useTerminalsStore.getState().upsert(info))
      .finally(() => (creating = null));
  }, [loaded, terminal]);

  if (!terminal) {
    return <EmptyState title="Starting terminal…" className="h-full" />;
  }
  return (
    <div
      data-testid="terminal-panel"
      data-terminal-id={terminal.id}
      className="h-full overflow-hidden rounded-card border border-line-subtle bg-terminal"
    >
      <TerminalView terminalId={terminal.id} autoFocus />
    </div>
  );
}
