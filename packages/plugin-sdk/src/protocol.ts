/** Wire format between a plugin view (SDK) and the shell over the MessagePort. */
export const SDK_PROTOCOL_VERSION = 1;

export interface InitMessage {
  type: 'oxy:init';
  protocol: number;
  viewId: string;
  kind: 'view' | 'panel';
  projectId?: string;
  params?: unknown;
  locale: string;
  theme: Record<string, string>;
  state?: unknown;
  /** Normalized chords ("ctrl+shift+p") the shell handles; the SDK prevents their default. */
  reservedKeybindings: string[];
  visible: boolean;
}

export type ShellOp =
  | 'executeCommand'
  | 'openPanel'
  | 'setTitle'
  | 'setBadge'
  | 'showContextMenu'
  | 'setState'
  | 'openExternal'
  | 'copyToClipboard';

/** View → shell. */
export type ViewToShell =
  | { t: 'msg'; payload: unknown }
  | { t: 'req'; id: number; method: string; payload: unknown }
  | { t: 'shell'; id: number; op: ShellOp; args: unknown[] }
  | { t: 'key'; code: string; key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean };

/** Shell → view. */
export type ShellToView =
  | { t: 'msg'; payload: unknown }
  | { t: 'res'; id: number; ok: true; result: unknown }
  | { t: 'res'; id: number; ok: false; error: string }
  | { t: 'evt'; name: 'visibility' | 'theme' | 'resolved' | 'error'; payload: unknown };
