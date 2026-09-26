import { Dialog } from 'radix-ui';
import { SquareTerminal, Bot } from 'lucide-react';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { TerminalProfile } from '@shared/domain/terminal-profile';
import { ipc } from '../../lib/ipc-client';
import { newTerminal } from './layout-commands';
import { getActiveWorkspace } from './workspace-registry';

interface ProfilePickerStore {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const useProfilePickerStore = create<ProfilePickerStore>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));

/** "New terminal with profile" (Ctrl+Shift+N): pick a detected shell or agent profile. */
export function ProfilePicker() {
  const isOpen = useProfilePickerStore((s) => s.isOpen);
  const close = useProfilePickerStore((s) => s.close);
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void ipc.invoke('terminals:profiles').then((p) => {
      if (!cancelled) setProfiles(p);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const pick = (profileId: string) => {
    close();
    const ws = getActiveWorkspace();
    if (ws) void newTerminal(ws.api, ws.projectId, profileId);
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-app/60" />
        <Dialog.Content
          data-testid="profile-picker"
          className="fixed top-24 left-1/2 z-50 w-[420px] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-card border border-line bg-elevated p-2 shadow-elevated"
        >
          <Dialog.Title className="oxy-label px-2 py-1">New terminal</Dialog.Title>
          <Dialog.Description className="sr-only">Choose a terminal profile</Dialog.Description>
          <ul className="mt-1 flex flex-col">
            {profiles.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="flex h-8 w-full items-center gap-2 rounded-badge px-2 text-left text-ui text-fg hover:bg-accent-muted focus-visible:bg-accent-muted"
                  onClick={() => pick(p.id)}
                >
                  {p.kind === 'agent' ? (
                    <Bot size={14} className="text-agent" />
                  ) : (
                    <SquareTerminal size={14} className="text-fg-muted" />
                  )}
                  <span className="flex-1 truncate">{p.name}</span>
                  <span className="font-mono text-small text-fg-muted">{p.kind === 'agent' ? 'AI AGENT' : p.id}</span>
                </button>
              </li>
            ))}
            {profiles.length === 0 && <li className="px-2 py-2 text-fg-muted">Detecting profiles…</li>}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
