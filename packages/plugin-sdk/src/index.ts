import { type InitMessage, SDK_PROTOCOL_VERSION, type ShellOp, type ShellToView, type ViewToShell } from './protocol';

export type { InitMessage } from './protocol';

export interface ContextMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  separator?: boolean;
}

/** docs/plan/07-plugin-engine.md §7.9 */
export interface OxyView<Params = unknown, State = unknown> {
  readonly viewId: string;
  readonly kind: 'view' | 'panel';
  readonly projectId?: string;
  readonly params: Params;
  readonly locale: string;
  readonly visible: boolean;
  getState(): State | undefined;
  setState(state: State): void;
  postMessage(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): () => void;
  request<R = unknown, P = unknown>(method: string, params?: P, opts?: { timeoutMs?: number }): Promise<R>;
  onVisibilityChange(cb: (visible: boolean) => void): () => void;
  onThemeChange(cb: (tokens: Record<string, string>) => void): () => void;
  /** Called when the backend reports an error for this view (e.g. provider missing). */
  onError(cb: (message: string) => void): () => void;
  executeCommand<R = unknown>(id: string, ...args: unknown[]): Promise<R>;
  openPanel(panelType: string, o?: { params?: unknown; placement?: 'active-group' | 'right' | 'below' }): Promise<void>;
  setTitle(title: string): void;
  setBadge(badge?: { text: string; tone?: 'neutral' | 'warning' | 'danger' }): void;
  showContextMenu(items: ContextMenuItem[], at: { x: number; y: number }): Promise<string | undefined>;
  openExternal(url: string): Promise<void>;
  copyToClipboard(text: string): Promise<void>;
}

const MAX_STATE_BYTES = 256 * 1024;

function applyTheme(tokens: Record<string, string>): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
  root.dataset['oxyTheme'] = tokens['--color-scheme'] === 'light' ? 'light' : 'dark';
}

/** "KeyB" → "b", "Digit1" → "1", "F7" → "f7" (same names as the shell's keybindings). */
function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code.toLowerCase();
  const names: Record<string, string> = {
    Equal: '=',
    Minus: '-',
    Backquote: '`',
    Comma: ',',
    Period: '.',
    Slash: '/',
    Enter: 'enter',
    Tab: 'tab',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    ArrowUp: 'up',
    ArrowDown: 'down',
  };
  return names[code] ?? null;
}

function chord(e: KeyboardEvent): string | null {
  const key = keyName(e.code);
  if (!key) return null;
  return [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'cmd', key]
    .filter(Boolean)
    .join('+');
}

/**
 * Connects the view to the shell: `oxy:hello` → `oxy:init` with a MessagePort (docs/plan/07 §7.4). Resolves with
 * the view API; rejects when the shell does not answer (e.g. the page was opened outside Oxytocin).
 */
export function connect<P = unknown, S = unknown>(opts: { timeoutMs?: number } = {}): Promise<OxyView<P, S>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onInit);
      reject(new Error('Oxytocin did not answer the view handshake'));
    }, opts.timeoutMs ?? 10_000);

    function onInit(event: MessageEvent) {
      if (event.source !== window.parent) return;
      const data = event.data as Partial<InitMessage> | null;
      if (!data || data.type !== 'oxy:init' || !event.ports[0]) return;
      window.removeEventListener('message', onInit);
      clearTimeout(timer);
      resolve(createView<P, S>(data as InitMessage, event.ports[0]));
    }

    window.addEventListener('message', onInit);
    window.parent.postMessage({ type: 'oxy:hello', protocol: SDK_PROTOCOL_VERSION }, '*');
  });
}

function createView<P, S>(init: InitMessage, port: MessagePort): OxyView<P, S> {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const listeners = {
    msg: new Set<(m: unknown) => void>(),
    visibility: new Set<(v: boolean) => void>(),
    theme: new Set<(t: Record<string, string>) => void>(),
    error: new Set<(m: string) => void>(),
  };
  let state = init.state as S | undefined;
  let visible = init.visible;
  const send = (m: ViewToShell) => port.postMessage(m);
  applyTheme(init.theme);

  port.onmessage = (event: MessageEvent<ShellToView>) => {
    const m = event.data;
    if (m.t === 'msg') for (const l of listeners.msg) l(m.payload);
    else if (m.t === 'res') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error));
    } else if (m.t === 'evt') {
      if (m.name === 'visibility') {
        visible = m.payload as boolean;
        for (const l of listeners.visibility) l(visible);
      } else if (m.name === 'theme') {
        applyTheme(m.payload as Record<string, string>);
        for (const l of listeners.theme) l(m.payload as Record<string, string>);
      } else if (m.name === 'error') {
        for (const l of listeners.error) l((m.payload as { message?: string } | null)?.message ?? 'Error');
      }
    }
  };

  const call = <R>(build: (id: number) => ViewToShell, timeoutMs = 30_000): Promise<R> =>
    new Promise<R>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Request timed out'));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      send(build(id));
    });
  const shell = <R>(op: ShellOp, ...args: unknown[]) => call<R>((id) => ({ t: 'shell', id, op, args }));
  const subscribe =
    <T>(set: Set<(v: T) => void>) =>
    (cb: (v: T) => void) => {
      set.add(cb);
      return () => set.delete(cb);
    };

  // Shell shortcuts keep working while the view has focus (Escape always stays in the view).
  const reserved = new Set(init.reservedKeybindings);
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') return;
      const isFn = /^F\d{1,2}$/.test(e.code);
      if (!isFn && !e.ctrlKey && !e.altKey && !e.metaKey) return;
      const c = chord(e);
      if (c && reserved.has(c)) e.preventDefault();
      send({
        t: 'key',
        code: e.code,
        key: e.key,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
      });
    },
    true,
  );

  return {
    viewId: init.viewId,
    kind: init.kind,
    ...(init.projectId ? { projectId: init.projectId } : {}),
    params: init.params as P,
    locale: init.locale,
    get visible() {
      return visible;
    },
    getState: () => state,
    setState: (next) => {
      const json = JSON.stringify(next);
      if (json.length > MAX_STATE_BYTES) throw new Error('View state is limited to 256 KB');
      state = next;
      void shell('setState', JSON.parse(json) as unknown);
    },
    postMessage: (msg) => send({ t: 'msg', payload: msg }),
    onMessage: subscribe(listeners.msg),
    request: <R, Q>(method: string, params?: Q, o?: { timeoutMs?: number }) =>
      call<R>((id) => ({ t: 'req', id, method, payload: params }), o?.timeoutMs),
    onVisibilityChange: subscribe(listeners.visibility),
    onThemeChange: subscribe(listeners.theme),
    onError: subscribe(listeners.error),
    executeCommand: <R>(id: string, ...args: unknown[]) => shell<R>('executeCommand', id, ...args),
    openPanel: (panelType, o) => shell('openPanel', panelType, o ?? {}),
    setTitle: (title) => void shell('setTitle', title),
    setBadge: (badge) => void shell('setBadge', badge ?? null),
    showContextMenu: (items, at) => shell<string | undefined>('showContextMenu', items, at),
    openExternal: (url) => shell('openExternal', url),
    copyToClipboard: (text) => shell('copyToClipboard', text),
  };
}
