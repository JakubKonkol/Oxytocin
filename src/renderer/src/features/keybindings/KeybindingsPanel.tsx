import type { IDockviewPanelProps } from 'dockview-react';
import { AlertTriangle, FileJson, Pencil, RotateCcw, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { KEY_CONTEXTS, parseWhen } from '@shared/domain/keybindings';
import { cn } from '../../lib/cn';
import { getCommands, hasCommand, registerCommand } from '../../lib/commands';
import { ipc } from '../../lib/ipc-client';
import { effectiveKeybindings, onDidChangeKeybindings } from '../../lib/keyboard';
import { chordFromEvent, keyNameFromCode } from '../../lib/keybindings';
import { currentPlatform } from '../../lib/platform';
import { Button } from '../../ui/Button';
import { IconButton } from '../../ui/IconButton';
import { Kbd } from '../../ui/Kbd';
import { notify } from '../../ui/Toast';
import { getActiveWorkspace } from '../layout/workspace-registry';
import { setCommandKeybindings, useKeybindingsStore } from './keybindings-store';
import { buildRows, commandsUsing, entriesForChange, type ShortcutRow, worksInTerminal } from './shortcuts-model';

export const KEYBINDINGS_PANEL_ID = 'keybindings-editor';

/** Opens (or focuses) the Keyboard Shortcuts editor in the active project's workspace. */
export function openKeybindingsEditor(): void {
  const workspace = getActiveWorkspace();
  if (!workspace) {
    notify('info', 'Open a project to edit keyboard shortcuts');
    return;
  }
  const existing = workspace.api.getPanel(KEYBINDINGS_PANEL_ID);
  if (existing) {
    existing.api.setActive();
    return;
  }
  workspace.api.addPanel({ id: KEYBINDINGS_PANEL_ID, component: 'keybindings', title: 'Keyboard Shortcuts' });
}

async function openKeybindingsFile(): Promise<void> {
  try {
    await ipc.invoke('keybindings:openFile');
  } catch (e) {
    notify('error', 'Could not open keybindings.json', { description: e instanceof Error ? e.message : String(e) });
  }
}

export function registerKeybindingCommands(): void {
  registerCommand({
    id: 'workbench.openKeybindings',
    title: 'Preferences: Open Keyboard Shortcuts',
    run: () => openKeybindingsEditor(),
  });
  registerCommand({
    id: 'workbench.openKeybindingsFile',
    title: 'Preferences: Open Keyboard Shortcuts (JSON)',
    run: () => openKeybindingsFile(),
  });
}

async function save(command: string, entries: Parameters<typeof setCommandKeybindings>[1]): Promise<void> {
  try {
    await setCommandKeybindings(command, entries);
  } catch (e) {
    notify('error', 'Could not change the shortcut', { description: e instanceof Error ? e.message : String(e) });
  }
}

const WHEN_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Everywhere' },
  { value: '!terminalFocus', label: 'Outside terminals' },
  { value: 'terminalFocus', label: 'In terminals' },
  { value: 'diffFocus', label: 'In diffs' },
  { value: 'changesFocus', label: 'In the CHANGES list' },
  { value: 'sidebarFocus', label: 'In the sidebar' },
];

function Recorder({ row, onClose }: { row: ShortcutRow; onClose: () => void }) {
  const [chord, setChord] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const initialWhen = row.bindings[0]?.when ?? '';
  const [when, setWhen] = useState(initialWhen);
  const platform = currentPlatform();
  const titleOf = (id: string) => getCommands().find((c) => c.id === id)?.title ?? id;
  const used = chord ? commandsUsing(chord, row.command, effectiveKeybindings(), platform, titleOf) : [];
  const whenOk = !('error' in parseWhen(when));
  const options = WHEN_OPTIONS.some((o) => o.value === when)
    ? WHEN_OPTIONS
    : [...WHEN_OPTIONS, { value: when, label: when }];

  const confirm = () => {
    if (!chord || !whenOk) return;
    onClose();
    void save(
      row.command,
      entriesForChange(
        row.command,
        chord,
        when || undefined,
        row.bindings.some((b) => b.source === 'default'),
      ),
    );
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-app/60" />
        <Dialog.Content
          data-testid="keybinding-recorder"
          data-no-keybindings
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            boxRef.current?.focus();
          }}
          className="fixed top-24 left-1/2 z-50 w-[460px] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-card border border-line bg-elevated p-4 shadow-elevated"
          onKeyDownCapture={(e) => {
            // Keys are recorded only while the capture box has focus; the select and buttons work normally.
            if (e.target !== boxRef.current) return;
            const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
            if (plain && e.key === 'Escape') return; // Radix closes the dialog.
            e.preventDefault();
            e.stopPropagation();
            if (plain && e.key === 'Enter') {
              confirm();
              return;
            }
            if (!keyNameFromCode(e.nativeEvent.code)) return; // A modifier alone.
            setChord(chordFromEvent(e.nativeEvent));
          }}
        >
          <Dialog.Title className="text-ui font-medium text-fg">{row.title}</Dialog.Title>
          <p className="mt-1 text-small text-fg-muted">
            Press the desired key combination, then Enter. Escape cancels.
          </p>
          <div
            ref={boxRef}
            tabIndex={0}
            data-testid="keybinding-recorder-chord"
            aria-label="Shortcut"
            className="mt-3 flex h-10 items-center justify-center rounded-control border border-line bg-input"
          >
            {chord ? <Kbd shortcut={chord} /> : <span className="text-fg-muted">Waiting for keys…</span>}
          </div>
          {chord && used.length > 0 && (
            <p
              data-testid="keybinding-recorder-conflict"
              className="mt-2 flex items-start gap-1.5 text-small text-warning"
            >
              <AlertTriangle size={12} className="mt-0.5 flex-none" />
              Also used by {used.join(', ')}. The new shortcut takes precedence.
            </p>
          )}
          {chord && !worksInTerminal(chord) && when !== '!terminalFocus' && (
            <p data-testid="keybinding-recorder-terminal" className="mt-2 text-small text-fg-muted">
              Terminals keep this combination for the shell and agents; it works everywhere else.
            </p>
          )}
          <label className="mt-3 flex items-center gap-2 text-small text-fg-secondary">
            Applies
            <select
              data-testid="keybinding-recorder-when"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              className="h-7 rounded-control border border-line bg-input px-1 text-ui text-fg"
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={!chord || !whenOk} onClick={confirm}>
              Save
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Row({ row, onEdit }: { row: ShortcutRow; onEdit: (row: ShortcutRow) => void }) {
  const conflicts = [...new Set(row.bindings.flatMap((b) => b.conflicts))];
  return (
    <tr
      data-testid="keybinding-row"
      data-command={row.command}
      className="group border-b border-line-subtle hover:bg-accent-muted/40"
      onDoubleClick={() => onEdit(row)}
    >
      <td className="py-1.5 pr-3 pl-4">
        <div className="truncate text-fg">{row.title}</div>
        <div className="truncate font-mono text-small text-fg-muted">{row.command}</div>
      </td>
      <td className="py-1.5 pr-3" data-testid="keybinding-chords">
        <div className="flex flex-wrap items-center gap-1">
          {row.bindings.map((b, i) => (
            <Kbd key={i} shortcut={b.chord} />
          ))}
          {row.bindings.length === 0 && <span className="text-fg-muted">—</span>}
          {conflicts.length > 0 && (
            <span
              data-testid="keybinding-conflict"
              title={`Also bound to: ${conflicts.join(', ')}`}
              className="text-warning"
            >
              <AlertTriangle size={12} />
            </span>
          )}
        </div>
      </td>
      <td className="py-1.5 pr-3 font-mono text-small text-fg-secondary">
        {[...new Set(row.bindings.map((b) => b.when).filter(Boolean))].join(', ')}
      </td>
      <td className="py-1.5 pr-3 text-small text-fg-muted" data-testid="keybinding-source">
        {row.customized ? 'User' : 'Default'}
      </td>
      <td className="py-1.5 pr-4">
        <div className="flex justify-end gap-0.5 opacity-60 group-hover:opacity-100">
          <IconButton
            label="Change shortcut"
            data-testid="keybinding-edit"
            icon={<Pencil size={12} />}
            onClick={() => onEdit(row)}
          />
          {row.bindings.length > 0 && (
            <IconButton
              label="Remove shortcut"
              data-testid="keybinding-remove"
              icon={<X size={12} />}
              onClick={() => void save(row.command, [{ command: `-${row.command}` }])}
            />
          )}
          {row.customized && (
            <IconButton
              label="Reset to default"
              data-testid="keybinding-reset"
              icon={<RotateCcw size={12} />}
              onClick={() => void save(row.command, [])}
            />
          )}
        </div>
      </td>
    </tr>
  );
}

/** Keyboard shortcut editor (roadmap M7-T2): search, change/remove/reset, conflicts; writes keybindings.json. */
export function KeybindingsPanel(_props: IDockviewPanelProps) {
  const state = useKeybindingsStore((s) => s.state);
  const effective = useSyncExternalStore(onDidChangeKeybindings, effectiveKeybindings);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<ShortcutRow | null>(null);
  const platform = currentPlatform();

  const rows = useMemo(() => {
    const commands = getCommands()
      .filter((c) => !c.internal)
      .map((c) => ({ id: c.id, title: c.title }));
    return buildRows(commands, effective, state?.entries ?? [], platform, hasCommand);
  }, [effective, state, platform]);

  const q = query.trim().toLowerCase();
  const visible = q
    ? rows.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.command.toLowerCase().includes(q) ||
          r.bindings.some((b) => b.chord.includes(q.replace(/\s+/g, ''))),
      )
    : rows;
  const problems = state?.problems ?? [];

  return (
    <div data-testid="keybindings-panel" className="flex h-full min-h-0 flex-col bg-card text-ui">
      <div className="flex h-10 flex-none items-center gap-2 border-b border-line-subtle px-4">
        <span className="font-medium text-fg">Keyboard Shortcuts</span>
        <input
          data-testid="keybindings-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search commands or keys (e.g. ctrl+shift)"
          className="ml-2 h-7 min-w-0 flex-1 rounded-control border border-line bg-input px-2 text-ui text-fg placeholder:text-fg-muted"
        />
        <Button
          size="sm"
          variant="ghost"
          data-testid="keybindings-open-file"
          onClick={() => void openKeybindingsFile()}
        >
          <FileJson size={12} /> Open keybindings.json
        </Button>
      </div>
      {problems.length > 0 && (
        <div
          data-testid="keybindings-problems"
          className="flex-none border-b border-line-subtle bg-warning/10 px-4 py-2 text-small text-warning"
        >
          {problems.map((p, i) => (
            <div key={i}>
              keybindings.json{p.index >= 0 ? ` entry ${p.index + 1}` : ''}: {p.message}
            </div>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full table-fixed border-collapse text-left">
          <colgroup>
            <col />
            <col className="w-[200px]" />
            <col className="w-[150px]" />
            <col className="w-[70px]" />
            <col className="w-[96px]" />
          </colgroup>
          <thead className="sticky top-0 bg-card">
            <tr className="oxy-label border-b border-line-subtle">
              <th className="py-1.5 pr-3 pl-4 font-normal">Command</th>
              <th className="py-1.5 pr-3 font-normal">Keybinding</th>
              <th className="py-1.5 pr-3 font-normal">When</th>
              <th className="py-1.5 pr-3 font-normal">Source</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <Row key={r.command} row={r} onEdit={setEditing} />
            ))}
          </tbody>
        </table>
        {visible.length === 0 && <div className="px-4 py-3 text-fg-muted">No matching commands.</div>}
      </div>
      <div className={cn('flex-none border-t border-line-subtle px-4 py-1.5 text-small text-fg-muted')}>
        Contexts for "when": {KEY_CONTEXTS.join(', ')}. Plain Ctrl+letter shortcuts never fire inside terminals.
      </div>
      {editing && <Recorder row={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
