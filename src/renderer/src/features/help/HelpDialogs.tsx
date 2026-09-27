import { Dialog } from 'radix-ui';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { AppInfo } from '@shared/domain/app-info';
import logo from '../../assets/brand/app-icon-small.svg';
import { registerCommand } from '../../lib/commands';
import { ipc } from '../../lib/ipc-client';
import { Button } from '../../ui/Button';

type HelpDialog = 'about' | 'notices' | 'license' | null;

export const useHelpStore = create<{ open: HelpDialog; show: (d: HelpDialog) => void }>((set) => ({
  open: null,
  show: (open) => set({ open }),
}));

export function registerHelpCommands(): void {
  registerCommand({
    id: 'workbench.about',
    title: 'Help: About Oxytocin',
    run: () => useHelpStore.getState().show('about'),
  });
  registerCommand({
    id: 'workbench.thirdPartyNotices',
    title: 'Help: Third-Party Notices',
    run: () => useHelpStore.getState().show('notices'),
  });
}

const contentClass =
  'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-80px)] w-[520px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-card border border-line bg-elevated p-5 shadow-elevated';

function About() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const show = useHelpStore((s) => s.show);
  useEffect(() => {
    void ipc.invoke('app:getInfo').then(setInfo);
  }, []);
  return (
    <div data-testid="about-dialog" className="flex flex-col items-center gap-3 text-center">
      <img src={logo} alt="" aria-hidden width={48} height={48} />
      <Dialog.Title className="text-[18px] font-semibold text-fg">Oxytocin</Dialog.Title>
      <Dialog.Description className="text-fg-secondary">
        A desktop hub for developers who work with AI coding agents.
      </Dialog.Description>
      <div className="font-mono text-small text-fg-muted" data-testid="about-version">
        Version {info?.version ?? '…'}
        {info &&
          ` · Electron ${info.versions.electron} · Chromium ${info.versions.chrome} · Node ${info.versions.node}`}
      </div>
      <div className="text-small text-fg-secondary">
        Copyright © 2026 Jakub Konkol. Released under the{' '}
        <button type="button" className="text-accent hover:underline" onClick={() => show('license')}>
          MIT License
        </button>
        .
      </div>
      <div className="mt-2 flex gap-2">
        <Button variant="secondary" onClick={() => show('notices')}>
          Third-Party Notices
        </Button>
        <Dialog.Close asChild>
          <Button variant="primary">Close</Button>
        </Dialog.Close>
      </div>
    </div>
  );
}

function Document({ doc }: { doc: 'notices' | 'license' }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    ipc.invoke('app:readLegal', { doc }).then(
      (r) => setText(r.text),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [doc]);
  return (
    <div data-testid={`legal-${doc}`} className="flex min-h-0 flex-col gap-3">
      <Dialog.Title className="font-semibold text-fg">
        {doc === 'notices' ? 'Third-Party Notices' : 'MIT License'}
      </Dialog.Title>
      <Dialog.Description className="text-small text-fg-muted">
        {doc === 'notices'
          ? 'Oxytocin includes the open-source software listed below.'
          : 'Oxytocin is free software under the MIT License.'}
      </Dialog.Description>
      <pre className="min-h-0 flex-1 overflow-auto rounded-control border border-line-subtle bg-input p-3 font-mono text-small whitespace-pre-wrap text-fg-secondary">
        {error ?? text ?? 'Loading…'}
      </pre>
      <div className="flex justify-end">
        <Dialog.Close asChild>
          <Button variant="secondary">Close</Button>
        </Dialog.Close>
      </div>
    </div>
  );
}

/** About Oxytocin, the MIT license and the third-party notices (docs/plan/10-quality-testing-release.md §8). */
export function HelpDialogs() {
  const open = useHelpStore((s) => s.open);
  const show = useHelpStore((s) => s.show);
  return (
    <Dialog.Root open={open !== null} onOpenChange={(o) => !o && show(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-app/60" />
        <Dialog.Content className={open === 'about' ? contentClass : `${contentClass} h-[70vh] w-[760px]`}>
          {open === 'about' && <About />}
          {(open === 'notices' || open === 'license') && <Document doc={open} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
