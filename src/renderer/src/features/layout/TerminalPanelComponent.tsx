import type { IDockviewPanelProps } from 'dockview-react';
import { useCallback, useEffect, useState } from 'react';
import { TerminalPanel } from '../terminals/TerminalPanel';
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
