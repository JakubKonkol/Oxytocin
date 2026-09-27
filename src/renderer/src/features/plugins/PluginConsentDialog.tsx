import { AlertTriangle } from 'lucide-react';
import { create } from 'zustand';
import type { PluginDescriptor } from '@shared/domain/plugin';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { BACKEND_WARNING, consentDetails } from './consent-model';

interface Pending {
  plugin: PluginDescriptor;
  resolve: (ok: boolean) => void;
}

const useConsentStore = create<{ pending: Pending | null }>(() => ({ pending: null }));

/** Asks the user before a plugin they installed runs for the first time. */
export function requestPluginConsent(plugin: PluginDescriptor): Promise<boolean> {
  useConsentStore.getState().pending?.resolve(false);
  return new Promise((resolve) => useConsentStore.setState({ pending: { plugin, resolve } }));
}

function settle(ok: boolean): void {
  const pending = useConsentStore.getState().pending;
  useConsentStore.setState({ pending: null });
  pending?.resolve(ok);
}

export function PluginConsentDialog() {
  const pending = useConsentStore((s) => s.pending);
  if (!pending) return null;
  const { plugin } = pending;
  const details = consentDetails(plugin);
  return (
    <ConfirmDialog
      open
      title={`Enable ${plugin.displayName}?`}
      description={`Version ${plugin.version} by ${details.publisher} (${plugin.id}).`}
      confirmLabel="Enable"
      cancelLabel="Not now"
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    >
      <div data-testid="plugin-consent" className="flex flex-col gap-3 text-fg-secondary">
        {details.replacesBuiltin && <p>It replaces the built-in plugin with the same id.</p>}
        {details.permissions.length > 0 ? (
          <div>
            <div className="mb-1 font-medium text-fg">It asks to:</div>
            <ul className="list-disc pl-5" data-testid="plugin-consent-permissions">
              {details.permissions.map((p) => (
                <li key={p.id} title={p.id}>
                  {p.description}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p>It asks for no permissions.</p>
        )}
        {details.hasBackend && (
          <p
            data-testid="plugin-consent-warning"
            className="flex gap-2 rounded-control border border-line-subtle bg-input p-2 text-warning"
          >
            <AlertTriangle size={14} className="mt-0.5 flex-none" />
            <span>{BACKEND_WARNING}</span>
          </p>
        )}
      </div>
    </ConfirmDialog>
  );
}
