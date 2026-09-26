import { useEffect } from 'react';
import { useSettingsStore } from '../../stores/settings-store';
import { useTerminalsStore } from '../../stores/terminals-store';
import { TerminalProgress } from './TerminalBadges';
import { TerminalExitBar } from './TerminalExitBar';
import { TerminalView } from './TerminalView';

export interface TerminalPanelProps {
  terminalId: string;
  autoFocus?: boolean;
  onRestart: () => void;
  onClose: () => void;
}

/** Terminal content of a panel: progress line, the xterm view and the exit bar. */
export function TerminalPanel({ terminalId, autoFocus, onRestart, onClose }: TerminalPanelProps) {
  const info = useTerminalsStore((s) => s.terminals[terminalId]);
  const closeOnExit = useSettingsStore((s) => s.settings?.['terminal.closeOnExit'] ?? 'ifClean');
  const state = info?.state;
  const exitCode = info?.exitCode;
  const kind = info?.kind;

  useEffect(() => {
    if (state !== 'exited') return;
    const clean = (exitCode ?? 0) === 0;
    if (closeOnExit === 'always' || (closeOnExit === 'ifClean' && clean && kind !== 'agent')) {
      const timer = setTimeout(onClose, 1000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [state, exitCode, kind, closeOnExit, onClose]);

  if (!info) return null;
  return (
    <div className="flex h-full flex-col">
      <TerminalProgress info={info} />
      <div className="min-h-0 flex-1">
        <TerminalView
          terminalId={terminalId}
          {...(autoFocus ? { autoFocus } : {})}
          onRestart={onRestart}
          onClose={onClose}
        />
      </div>
      {info.state !== 'running' && <TerminalExitBar info={info} onRestart={onRestart} onClose={onClose} />}
    </div>
  );
}
