import { Pencil } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { getCommands, hasCommand, registerCommand } from '../../lib/commands';
import { effectiveKeybindings, onDidChangeKeybindings } from '../../lib/keyboard';
import { currentPlatform } from '../../lib/platform';
import { Button } from '../../ui/Button';
import { Kbd } from '../../ui/Kbd';
import { openKeybindingsEditor } from './KeybindingsPanel';
import { useKeybindingsStore } from './keybindings-store';
import { buildRows, type CheatSheetEntry, cheatSheet } from './shortcuts-model';

export const useShortcutsDialog = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/** Shows the keyboard shortcuts overview (or hides it when it is open). */
export function toggleShortcutsDialog(): void {
  const { open, setOpen } = useShortcutsDialog.getState();
  setOpen(!open);
}

export function registerShortcutsCommands(): void {
  registerCommand({
    id: 'workbench.showShortcuts',
    title: 'Help: Keyboard Shortcuts',
    run: () => toggleShortcutsDialog(),
  });
}

function Entry({ entry }: { entry: CheatSheetEntry }) {
  return (
    <div data-testid="shortcut-entry" className="flex items-baseline justify-between gap-3 py-1">
      <span className="min-w-0 text-fg-secondary">{entry.title}</span>
      <span className="flex flex-none flex-wrap items-center justify-end gap-1">
        {entry.chords.map((c, i) => (
          <span key={c} className="flex items-center gap-1">
            {i > 0 && <span className="text-small text-fg-muted">{entry.range ? '…' : 'or'}</span>}
            <Kbd shortcut={c} />
          </span>
        ))}
      </span>
    </div>
  );
}

function Overview() {
  const user = useKeybindingsStore((s) => s.state?.entries);
  const effective = useSyncExternalStore(onDidChangeKeybindings, effectiveKeybindings);
  const [query, setQuery] = useState('');
  const platform = currentPlatform();
  const groups = useMemo(() => {
    const commands = getCommands()
      .filter((c) => !c.internal)
      .map((c) => ({ id: c.id, title: c.title }));
    return cheatSheet(buildRows(commands, effective, user ?? [], platform, hasCommand), effective, platform, query);
  }, [effective, user, platform, query]);

  return (
    <>
      <div className="flex flex-none items-center gap-3">
        <Dialog.Title className="font-semibold text-fg">Keyboard Shortcuts</Dialog.Title>
        <input
          data-testid="shortcuts-search"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search (e.g. terminal, ctrl+shift)"
          className="h-7 min-w-0 flex-1 rounded-control border border-line bg-input px-2 text-ui text-fg placeholder:text-fg-muted"
        />
      </div>
      <Dialog.Description className="mt-1 flex-none text-small text-fg-muted">
        Shortcuts of commands can be changed; those of the editor, terminals and dialogs are built in. Plain Ctrl+letter
        shortcuts stay with the shell and agents inside terminals.
      </Dialog.Description>
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
        <div data-testid="shortcuts-groups" className="columns-1 gap-8 md:columns-2">
          {groups.map((g) => (
            <section
              key={g.name}
              data-testid="shortcuts-group"
              data-group={g.name}
              className="mb-4 break-inside-avoid text-ui"
            >
              <h3 className="oxy-label border-b border-line-subtle pb-1">{g.name}</h3>
              {g.entries.map((e) => (
                <Entry key={`${e.title}:${e.chords.join()}`} entry={e} />
              ))}
            </section>
          ))}
        </div>
        {groups.length === 0 && <div className="text-fg-muted">No matching shortcuts.</div>}
      </div>
      <div className="mt-3 flex flex-none justify-end gap-2">
        <Button
          variant="secondary"
          data-testid="shortcuts-customize"
          onClick={() => {
            useShortcutsDialog.getState().setOpen(false);
            openKeybindingsEditor();
          }}
        >
          <Pencil size={12} /> Customize…
        </Button>
        <Dialog.Close asChild>
          <Button variant="primary">Close</Button>
        </Dialog.Close>
      </div>
    </>
  );
}

/** Overview of every keyboard shortcut (title bar button, Help: Keyboard Shortcuts). */
export function ShortcutsDialog() {
  const open = useShortcutsDialog((s) => s.open);
  const setOpen = useShortcutsDialog((s) => s.setOpen);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-app/60" />
        <Dialog.Content
          data-testid="shortcuts-dialog"
          className="fixed top-1/2 left-1/2 z-50 flex h-[80vh] w-[860px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-card border border-line bg-elevated p-5 shadow-elevated"
        >
          {open && <Overview />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
