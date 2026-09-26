import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import { useAppInfo } from '../../stores/app-store';
import { useSettingsStore } from '../../stores/settings-store';
import { ptyChannel } from './pty-channel';
import { terminalRegistry } from './terminal-registry';
import { createXterm } from './xterm-factory';

export interface TerminalViewProps {
  terminalId: string;
  /** Focus the terminal when mounted / when it becomes active. */
  autoFocus?: boolean;
}

/**
 * A view onto a PTY Host terminal. The buffer lives in the PTY Host; this component can be destroyed and
 * re-created at any time (snapshot + stream), so it never owns terminal state.
 */
export function TerminalView({ terminalId, autoFocus = false }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const settings = useSettingsStore((s) => s.settings);
  const appInfo = useAppInfo();

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !settings || !appInfo) return;
    const { term, fit, enableWebgl, disposeWebgl } = createXterm(settings, {
      platform: appInfo.platform,
      osBuild: appInfo.osBuild,
    });
    term.open(container);
    enableWebgl();

    const measure = (): { cols: number; rows: number } | null => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return null; // hidden
      const dims = fit.proposeDimensions();
      return dims && dims.cols > 1 && dims.rows > 0 ? { cols: dims.cols, rows: dims.rows } : null;
    };
    const initial = measure();
    if (initial) term.resize(initial.cols, initial.rows);

    const sub = ptyChannel().subscribe(
      terminalId,
      {
        onSnapshot: (m) => {
          term.reset();
          if (m.cols !== term.cols || m.rows !== term.rows) term.resize(m.cols, m.rows);
          term.write(m.data, () => fitNow());
        },
        onData: (data) => term.write(data, () => sub.processed(data.length)),
        onExit: () => undefined,
        onError: () => undefined,
      },
      initial?.cols,
      initial?.rows,
    );
    const inputSub = term.onData((d) => sub.input(d));
    const binarySub = term.onBinary((d) => sub.binary(d));

    const fitNow = () => {
      const dims = measure();
      if (!dims || (dims.cols === term.cols && dims.rows === term.rows)) return;
      term.resize(dims.cols, dims.rows);
      sub.resize(dims.cols, dims.rows);
    };
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(fitNow);
      }, 50);
    });
    observer.observe(container);

    terminalRegistry.set(terminalId, { term, focus: () => term.focus() });
    if (autoFocus) term.focus();

    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
      cancelAnimationFrame(frame);
      inputSub.dispose();
      binarySub.dispose();
      sub.dispose();
      terminalRegistry.delete(terminalId);
      disposeWebgl();
      term.dispose();
    };
    // Settings changes are applied by re-creating the view only when the terminal changes; live option
    // updates arrive with the settings UI (M7).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, settings === null, appInfo === null]);

  return (
    <div
      data-testid={`terminal-view-${terminalId}`}
      className="h-full w-full overflow-hidden bg-terminal"
      style={{ padding: '4px 0 0 8px' }}
    >
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
