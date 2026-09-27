import '@xterm/xterm/css/xterm.css';
import { fileOpenersFor, openWithOpener } from '../plugins/plugin-commands';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { SearchAddon } from '@xterm/addon-search';
import type { Terminal } from '@xterm/xterm';
import { ContextMenu } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';
import { formatShortcut } from '../../ui/Kbd';
import { isDialogOpen } from '../../lib/focus';
import { shortcutFor } from '../../lib/keyboard';
import { registerFileLinkProvider } from './link-provider';
import { TerminalSearch } from './TerminalSearch';
import { useWorkspaceVisible } from '../layout/workspace-visibility';
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
  onRestart?: () => void;
  onClose?: () => void;
}

/**
 * A view onto a PTY Host terminal. The buffer lives in the PTY Host; this component can be destroyed and
 * re-created at any time (snapshot + stream), so it never owns terminal state.
 */
export function TerminalView({ terminalId, autoFocus = false, onRestart, onClose }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const settings = useSettingsStore((s) => s.settings);
  const appInfo = useAppInfo();
  const [search, setSearch] = useState<SearchAddon | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const termRef = useRef<{ term: Terminal; sendRaw: (d: string) => void } | null>(null);
  const webglRef = useRef<{ enable: () => void; dispose: () => void } | null>(null);
  const visible = useWorkspaceVisible();

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !settings || !appInfo) return;
    const { term, fit, enableWebgl, disposeWebgl } = createXterm(settings, {
      platform: appInfo.platform,
      osBuild: appInfo.osBuild,
    });
    term.open(container);
    webglRef.current = { enable: enableWebgl, dispose: disposeWebgl };
    enableWebgl();
    const searchAddon = new SearchAddon({ highlightLimit: 1000 });
    term.loadAddon(searchAddon);
    // The addon is created with the imperative terminal; the find widget renders from state.
    setSearch(searchAddon);

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

    const linkSub = registerFileLinkProvider(
      term,
      () => {
        const info = useTerminalsStore.getState().terminals[terminalId];
        return info ? [info.cwd] : [];
      },
      (target) => {
        // A plugin opener marked `default` for the extension wins over the editor (e.g. Markdown Preview).
        const opener = fileOpenersFor(target.path).find((o) => o.default);
        const projectId = useTerminalsStore.getState().terminals[terminalId]?.projectId;
        if (opener && projectId) void openWithOpener(opener, projectId, target.path);
        else void ipc.invoke('editor:open', target);
      },
    );

    const onFocus = () => {
      setActiveTerminal(terminalId);
      if (useTerminalsStore.getState().terminals[terminalId]?.bell)
        void ipc.invoke('terminals:clearBell', { id: terminalId });
    };
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

    termRef.current = { term, sendRaw };
    terminalRegistry.set(terminalId, { term, focus: () => term.focus(), sendRaw, openFind: () => setFindOpen(true) });
    if (autoFocus && !isDialogOpen()) term.focus();

    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
      cancelAnimationFrame(frame);
      inputSub.dispose();
      binarySub.dispose();
      selectionSub.dispose();
      linkSub.dispose();
      termRef.current = null;
      webglRef.current = null;
      setSearch(null);
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

  // Hidden (keep-alive) workspaces release their WebGL context; showing them again restores it.
  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    if (visible) {
      webglRef.current?.enable();
      t.term.refresh(0, t.term.rows - 1);
    } else {
      webglRef.current?.dispose();
    }
  }, [visible]);

  const run = (fn: (t: { term: Terminal; sendRaw: (d: string) => void }) => unknown) => {
    const t = termRef.current;
    if (t) void fn(t);
  };
  const shortcut = (command: string) => {
    const chord = shortcutFor(command);
    return chord ? formatShortcut(chord) : undefined;
  };
  const menuDisabled = settings?.['terminal.rightClickBehavior'] === 'copyPaste';
  const item =
    'flex h-7 cursor-default items-center justify-between gap-6 rounded-badge px-2 text-ui text-fg outline-none data-[disabled]:text-fg-muted data-[highlighted]:bg-accent-muted';

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild disabled={menuDisabled}>
        <div
          data-testid={`terminal-view-${terminalId}`}
          className="relative h-full w-full overflow-hidden bg-terminal"
          style={{ padding: '4px 0 0 8px' }}
        >
          <div ref={containerRef} className="h-full w-full" />
          {findOpen && search && (
            <TerminalSearch
              search={search}
              onClose={() => {
                setFindOpen(false);
                termRef.current?.term.focus();
              }}
            />
          )}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          data-testid="terminal-context-menu"
          className="z-50 min-w-48 rounded-control border border-line bg-elevated p-1 shadow-elevated"
        >
          <ContextMenu.Item className={item} onSelect={() => run(({ term }) => copySelection(term))}>
            Copy <span className="text-small text-fg-muted">{shortcut('terminal.copy')}</span>
          </ContextMenu.Item>
          <ContextMenu.Item className={item} onSelect={() => run(({ term, sendRaw }) => pasteClipboard(term, sendRaw))}>
            Paste <span className="text-small text-fg-muted">{shortcut('terminal.paste')}</span>
          </ContextMenu.Item>
          <ContextMenu.Item className={item} onSelect={() => run(({ term }) => term.selectAll())}>
            Select all
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-line-subtle" />
          <ContextMenu.Item className={item} onSelect={() => setFindOpen(true)}>
            Find… <span className="text-small text-fg-muted">{shortcut('terminal.find')}</span>
          </ContextMenu.Item>
          <ContextMenu.Item className={item} onSelect={() => run(({ term }) => term.clear())}>
            Clear <span className="text-small text-fg-muted">{shortcut('terminal.clear')}</span>
          </ContextMenu.Item>
          {(onRestart || onClose) && <ContextMenu.Separator className="my-1 h-px bg-line-subtle" />}
          {onRestart && (
            <ContextMenu.Item className={item} onSelect={onRestart}>
              Restart
            </ContextMenu.Item>
          )}
          {onClose && (
            <ContextMenu.Item className={item} onSelect={onClose}>
              Close
            </ContextMenu.Item>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
