import { RotateCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ViewEnvelope } from '@shared/rpc/contracts/plugin-host';
import { ipc } from '../../lib/ipc-client';
import { dispatchKeybinding, reservedChords } from '../../lib/keyboard';
import { usePluginsStore } from '../../stores/plugins-store';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { runCoreCommand } from '../layout/core-commands';
import { openPluginPanel } from './plugin-panels';
import { showViewContextMenu } from './view-context-menu';
import { onPluginReloaded, registerViewTarget, viewStates } from './view-bridge';
import { themeTokens } from './theme-tokens';

export interface PluginFrameProps {
  pluginId: string;
  entry: string;
  viewId: string;
  kind: 'view' | 'panel';
  providerId: string;
  projectId?: string;
  params?: unknown;
  title: string;
  visible: boolean;
  onTitle?: (title: string) => void;
  onBadge?: (badge: { text: string; tone?: 'neutral' | 'warning' | 'danger' } | null) => void;
  onStateChange?: () => void;
}

const HANDSHAKE_TIMEOUT_MS = 10_000;
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups-to-escape-sandbox';

type ViewMessage =
  | { t: 'msg'; payload: unknown }
  | { t: 'req'; id: number; method: string; payload: unknown }
  | { t: 'shell'; id: number; op: string; args: unknown[] }
  | { t: 'key'; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean };

/**
 * A plugin view in a sandboxed iframe (docs/plan/07-plugin-engine.md §7.3–7.8): handshake over a
 * MessageChannel, shell operations handled locally, everything else routed to the plugin backend.
 */
export function PluginFrame(props: PluginFrameProps) {
  const { pluginId, entry, viewId, kind, providerId, projectId, params, title, visible } = props;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | null>(null);
  const visibleRef = useRef(visible);
  const callbacks = useRef(props);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    callbacks.current = props;
  });

  // The plugin was reloaded: load the view again against the new backend.
  useEffect(
    () =>
      onPluginReloaded((id) => {
        if (id !== pluginId) return;
        setStatus('loading');
        setError(null);
        setReloadKey((k) => k + 1);
      }),
    [pluginId],
  );

  // Handshake + routing for this frame instance.
  useEffect(() => {
    const origin = `oxy-plugin://${pluginId}`;
    const post = (m: unknown) => portRef.current?.postMessage(m);
    const reply = (id: number, run: () => unknown) => {
      void Promise.resolve()
        .then(run)
        .then(
          (result) => post({ t: 'res', id, ok: true, result }),
          (e: unknown) => post({ t: 'res', id, ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
    };
    const shellOp = (id: number, op: string, args: unknown[]) => {
      switch (op) {
        case 'executeCommand': {
          const [command, ...rest] = args as [string, ...unknown[]];
          if (command.startsWith('oxytocin.')) return reply(id, () => runCoreCommand(command, rest));
          const known = usePluginsStore.getState().contributions.commands.some((c) => c.id === command);
          if (!known) return reply(id, () => Promise.reject(new Error(`Unknown command: ${command}`)));
          return reply(id, () => ipc.invoke('plugins:executeCommand', { id: command, args: rest }));
        }
        case 'openPanel': {
          const [panelType, o] = args as [string, { params?: unknown; placement?: 'active-group' | 'right' | 'below' }];
          return reply(id, () => openPluginPanel(panelType, { ...(o ?? {}), ...(projectId ? { projectId } : {}) }));
        }
        case 'setTitle':
          callbacks.current.onTitle?.(typeof args[0] === 'string' ? args[0] : '');
          return reply(id, () => undefined);
        case 'setBadge':
          callbacks.current.onBadge?.((args[0] as never) ?? null);
          return reply(id, () => undefined);
        case 'setState':
          viewStates.set(viewId, args[0]);
          callbacks.current.onStateChange?.();
          return reply(id, () => undefined);
        case 'showContextMenu': {
          const rect = iframeRef.current?.getBoundingClientRect();
          const [items, at] = args as [never, { x: number; y: number }];
          return reply(id, () =>
            showViewContextMenu(items, { x: (rect?.left ?? 0) + at.x, y: (rect?.top ?? 0) + at.y }),
          );
        }
        case 'openExternal':
          return reply(id, () => ipc.invoke('shell:openExternal', { url: String(args[0]) }));
        case 'copyToClipboard':
          return reply(id, () => ipc.invoke('clipboard:writeText', { text: String(args[0]) }));
        default:
          return reply(id, () => Promise.reject(new Error(`Unknown operation: ${op}`)));
      }
    };
    const onPortMessage = (event: MessageEvent<ViewMessage>) => {
      const m = event.data;
      if (m.t === 'shell') shellOp(m.id, m.op, m.args);
      else if (m.t === 'key') dispatchKeybinding(m, 'pluginViewFocus');
      else {
        const envelope: ViewEnvelope =
          m.t === 'msg'
            ? { kind: 'msg', payload: m.payload }
            : { kind: 'req', id: m.id, method: m.method, payload: m.payload };
        void ipc.invoke('plugins:viewMessage', { viewId, envelope }).catch((e: unknown) => {
          if (m.t === 'req') post({ t: 'res', id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
        });
      }
    };
    const onWindowMessage = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow || event.origin !== origin) return;
      const data = event.data as { type?: string } | null;
      if (data?.type !== 'oxy:hello') return;
      portRef.current?.close();
      const channel = new MessageChannel();
      portRef.current = channel.port1;
      channel.port1.onmessage = onPortMessage;
      frame.contentWindow?.postMessage(
        {
          type: 'oxy:init',
          protocol: 1,
          viewId,
          kind,
          ...(projectId ? { projectId } : {}),
          ...(params !== undefined ? { params } : {}),
          locale: navigator.language || 'en-US',
          theme: themeTokens(),
          ...(viewStates.has(viewId) ? { state: viewStates.get(viewId) } : {}),
          reservedKeybindings: reservedChords(),
          visible: visibleRef.current,
        },
        origin,
        [channel.port2],
      );
      setStatus('ready');
      void ipc
        .invoke('plugins:viewOpened', {
          viewId,
          pluginId,
          kind,
          providerId,
          ...(projectId ? { projectId } : {}),
          ...(params !== undefined ? { params } : {}),
          visible: visibleRef.current,
        })
        .catch((e: unknown) => {
          setStatus('error');
          setError(e instanceof Error ? e.message : String(e));
        });
    };
    window.addEventListener('message', onWindowMessage);
    const unregister = registerViewTarget(viewId, {
      deliver: (envelope) => {
        if (envelope.kind === 'msg') post({ t: 'msg', payload: envelope.payload });
        else if (envelope.kind === 'res') post({ t: 'res', ...envelope });
        else if (envelope.kind === 'evt') {
          if (envelope.name === 'error') {
            setStatus('error');
            setError((envelope.payload as { message?: string } | null)?.message ?? 'The view failed');
          }
          post({ t: 'evt', name: envelope.name, payload: envelope.payload });
        }
      },
      meta: (meta) => {
        if (meta.title !== undefined) callbacks.current.onTitle?.(meta.title);
        if (meta.badge !== undefined) callbacks.current.onBadge?.(meta.badge);
      },
    });
    const timeout = setTimeout(() => {
      if (!portRef.current) {
        setStatus('error');
        setError('The view did not connect (handshake timeout)');
      }
    }, HANDSHAKE_TIMEOUT_MS);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener('message', onWindowMessage);
      unregister();
      portRef.current?.close();
      portRef.current = null;
      void ipc.invoke('plugins:viewClosed', { viewId }).catch(() => undefined);
    };
  }, [pluginId, viewId, kind, providerId, projectId, params, reloadKey]);

  // Visibility → view + backend.
  useEffect(() => {
    visibleRef.current = visible;
    portRef.current?.postMessage({ t: 'evt', name: 'visibility', payload: visible });
    void ipc.invoke('plugins:viewVisibility', { viewId, visible }).catch(() => undefined);
  }, [visible, viewId]);

  const src = `oxy-plugin://${pluginId}/${entry.replace(/^\/+/, '')}?viewId=${encodeURIComponent(viewId)}`;
  return (
    <div className="relative h-full w-full" data-testid={`plugin-frame-${viewId}`} data-status={status}>
      <iframe
        key={reloadKey}
        ref={iframeRef}
        src={src}
        title={title}
        sandbox={SANDBOX}
        allow="clipboard-write"
        referrerPolicy="no-referrer"
        className="oxy-plugin-frame h-full w-full border-0 bg-transparent"
      />
      {status === 'loading' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-card text-small text-fg-muted">
          Loading…
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center bg-card">
          <EmptyState
            title="This view is unavailable"
            {...(error ? { description: error } : {})}
            actions={
              <Button
                variant="secondary"
                onClick={() => {
                  setStatus('loading');
                  setError(null);
                  setReloadKey((k) => k + 1);
                }}
              >
                <RotateCw size={13} /> Reload view
              </Button>
            }
          />
        </div>
      )}
    </div>
  );
}
