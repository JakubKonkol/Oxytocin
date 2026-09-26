import type { IDockviewPanelProps } from 'dockview-react';
import { useCallback, useEffect, useState } from 'react';
import { ipc } from '../../lib/ipc-client';
import { useTerminalsStore } from '../../stores/terminals-store';
import { TerminalPanel } from '../terminals/TerminalPanel';
import { useWorkspaceVisible } from './workspace-visibility';
import type { TerminalPanelParams } from './panel-registry';
import { requestClosePanel, restartTerminalPanel } from './workspace-actions';

/** Dockview panel hosting a terminal. Clicking anywhere in it activates the panel. */
export function TerminalPanelComponent(props: IDockviewPanelProps<TerminalPanelParams>) {
  const { api, containerApi, params } = props;
  const [active, setActive] = useState(api.isActive);
  useEffect(() => {
    const d = api.onDidActiveChange((e) => setActive(e.isActive));
    return () => d.dispose();
  }, [api]);
  // An error exit counts as seen once the panel was active and on screen for 1 s (docs/plan/03 §5.2).
  const visible = useWorkspaceVisible();
  const unseenError = useTerminalsStore((s) => {
    const info = s.terminals[params.terminalId];
    return !!info && (info.state === 'failed' || (info.state === 'exited' && (info.exitCode ?? 0) !== 0));
  });
  useEffect(() => {
    if (!unseenError || !active || !visible) return;
    const timer = setTimeout(() => {
      if (document.visibilityState === 'visible') void ipc.invoke('terminals:markSeen', { id: params.terminalId });
    }, 1000);
    return () => clearTimeout(timer);
  }, [unseenError, active, visible, params.terminalId]);
  const onRestart = useCallback(() => void restartTerminalPanel(containerApi, api.id), [containerApi, api]);
  const onClose = useCallback(
    () => void requestClosePanel(containerApi, api.id, { skipConfirm: true }),
    [containerApi, api],
  );
  return (
    <div
      data-testid={`terminal-panel-${params.terminalId}`}
      data-terminal-id={params.terminalId}
      data-panel-id={api.id}
      className="h-full"
      onPointerDownCapture={() => {
        if (!api.isActive) api.setActive();
      }}
    >
      <TerminalPanel
        key={params.terminalId}
        terminalId={params.terminalId}
        autoFocus={active}
        onRestart={onRestart}
        onClose={onClose}
      />
    </div>
  );
}
