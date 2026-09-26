import { useCallback, useEffect } from 'react';
import { DEFAULT_PROJECT_ID } from '@shared/domain/terminal';
import { ipc } from '../../lib/ipc-client';
import { useTerminalsStore } from '../../stores/terminals-store';
import { EmptyState } from '../../ui/EmptyState';
import { BellIndicator, TerminalKindBadge } from './TerminalBadges';
import { TerminalPanel } from './TerminalPanel';

let creating: Promise<unknown> | null = null;

/**
 * Temporary center area (M1): one terminal of the default project. Replaced by the dockview workspace in M2.
 * After a renderer reload it re-attaches to the existing terminal instead of creating a new one.
 */
export function DefaultTerminalArea() {
  const loaded = useTerminalsStore((s) => s.loaded);
  const terminal = useTerminalsStore((s) => Object.values(s.terminals).find((t) => t.projectId === DEFAULT_PROJECT_ID));
  const id = terminal?.id;

  useEffect(() => {
    if (!loaded || terminal || creating) return;
    creating = ipc
      .invoke('terminals:create', { projectId: DEFAULT_PROJECT_ID })
      .then((info) => useTerminalsStore.getState().upsert(info))
      .finally(() => (creating = null));
  }, [loaded, terminal]);

  const onRestart = useCallback(() => {
    if (id) void ipc.invoke('terminals:restart', { id }).then((info) => useTerminalsStore.getState().upsert(info));
  }, [id]);
  const onClose = useCallback(() => {
    if (id) void ipc.invoke('terminals:dispose', { id });
  }, [id]);

  if (!terminal) {
    return <EmptyState title="Starting terminal…" className="h-full" />;
  }
  return (
    <div
      data-testid="terminal-panel"
      data-terminal-id={terminal.id}
      className="flex h-full flex-col overflow-hidden rounded-card border border-line-subtle bg-terminal"
    >
      <div
        data-testid="terminal-header"
        className="flex h-8 flex-none items-center gap-2 border-b border-line-subtle bg-card px-3"
      >
        <span data-testid="terminal-title" className="min-w-0 truncate font-medium text-fg">
          {terminal.title}
        </span>
        <TerminalKindBadge info={terminal} />
        <BellIndicator info={terminal} />
      </div>
      <div className="min-h-0 flex-1">
        <TerminalPanel key={terminal.id} terminalId={terminal.id} autoFocus onRestart={onRestart} onClose={onClose} />
      </div>
    </div>
  );
}
