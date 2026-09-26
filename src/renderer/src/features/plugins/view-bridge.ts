import type { ViewEnvelope } from '@shared/rpc/contracts/plugin-host';
import { ipc } from '../../lib/ipc-client';

type Meta = { title?: string; badge?: { text: string; tone?: 'neutral' | 'warning' | 'danger' } | null };

interface BridgeTarget {
  deliver(envelope: ViewEnvelope): void;
  meta(meta: Meta): void;
}

const targets = new Map<string, BridgeTarget>();
let installed = false;

/** Routes backend → view traffic (`plugins:viewMessage`/`plugins:viewMeta` events) to mounted frames. */
export function registerViewTarget(viewId: string, target: BridgeTarget): () => void {
  if (!installed) {
    installed = true;
    ipc.on('plugins:viewMessage', ({ viewId: id, envelope }) => targets.get(id)?.deliver(envelope));
    ipc.on('plugins:viewMeta', ({ viewId: id, ...meta }) => targets.get(id)?.meta(meta));
  }
  targets.set(viewId, target);
  return () => {
    if (targets.get(viewId) === target) targets.delete(viewId);
  };
}

/** Per-instance view state (`oxy.setState`), kept across iframe re-creation and persisted with panels. */
export const viewStates = new Map<string, unknown>();
