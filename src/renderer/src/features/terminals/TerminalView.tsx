import '@xterm/xterm/css/xterm.css';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { useEffect, useRef } from 'react';
import { ipc } from '../../lib/ipc-client';
import { currentPlatform } from '../../lib/platform';
import { useAppInfo } from '../../stores/app-store';
import { confirmDialog } from '../../stores/dialog-store';
import { getSettings, useSettingsStore } from '../../stores/settings-store';
import { useTerminalsStore } from '../../stores/terminals-store';
import { createTerminalKeyHandler } from './key-handler';
import { formatDroppedPaths, type ShellType } from './path-quoting';
import { ptyChannel } from './pty-channel';
import { copySelection, pasteClipboard, setActiveTerminal } from './terminal-actions';
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
    const sendRaw = (data: string) => sub.input(data);
    const platform = currentPlatform();

    term.attachCustomKeyEventHandler(createTerminalKeyHandler({ term, platform, settings: getSettings, sendRaw }));

    // OSC 52: applications may write (never read) the clipboard, per `terminal.osc52`.
    term.loadAddon(
      new ClipboardAddon(undefined, {
        readText: () => '',
        writeText: async (_selection, text) => {
          const policy = getSettings()['terminal.osc52'];
          if (policy === 'deny') return;
          if (policy === 'ask') {
            const ok = await confirmDialog({
              title: 'Allow the terminal to copy to the clipboard?',
              description: text.length > 200 ? `${text.slice(0, 200)}…` : text,
              confirmLabel: 'Allow',
            });
            if (!ok) return;
          }
          await ipc.invoke('clipboard:writeText', { text });
        },
      }),
    );

    const selectionSub = term.onSelectionChange(() => {
      if (getSettings()['terminal.copyOnSelect'] && term.hasSelection()) {
        void ipc.invoke('clipboard:writeText', { text: term.getSelection() });
      }
    });

    // Windows console convention: right click copies the selection, or pastes when there is none.
    const onContextMenu = (e: MouseEvent) => {
      if (getSettings()['terminal.rightClickBehavior'] !== 'copyPaste') return;
      e.preventDefault();
      if (term.hasSelection()) void copySelection(term);
      else void pasteClipboard(term, sendRaw);
    };
    container.addEventListener('contextmenu', onContextMenu);

    // Dropping files pastes their quoted paths (handy for giving agents images and files).
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    };
    const onDrop = (e: DragEvent) => {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      e.preventDefault();
      const paths = files.map((f) => window.oxy.getPathForFile(f)).filter(Boolean);
      const shell = (useTerminalsStore.getState().terminals[terminalId]?.shellType ?? 'other') as ShellType;
      const text = formatDroppedPaths(paths, shell);
      if (text) term.paste(text);
      term.focus();
    };
    container.addEventListener('dragover', onDragOver);
    container.addEventListener('drop', onDrop);

    const onFocus = () => setActiveTerminal(terminalId);
    term.textarea?.addEventListener('focus', onFocus);

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

    terminalRegistry.set(terminalId, { term, focus: () => term.focus(), sendRaw });
    if (autoFocus) term.focus();

    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
      cancelAnimationFrame(frame);
      inputSub.dispose();
      binarySub.dispose();
      selectionSub.dispose();
      container.removeEventListener('contextmenu', onContextMenu);
      container.removeEventListener('dragover', onDragOver);
      container.removeEventListener('drop', onDrop);
      term.textarea?.removeEventListener('focus', onFocus);
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
