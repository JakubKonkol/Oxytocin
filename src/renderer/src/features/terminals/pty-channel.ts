import { ACK_BATCH_CHARS, type PtyToRenderer, type RendererToPty } from '@shared/rpc/contracts/pty-channel';

export interface PtyViewHandlers {
  onSnapshot(message: Extract<PtyToRenderer, { t: 'snapshot' }>): void;
  onData(data: string, seq: number): void;
  onExit(exitCode: number, signal?: number): void;
  onError(code: string, message: string): void;
}

export interface PtySubscription {
  input(data: string): void;
  binary(data: string): void;
  resize(cols: number, rows: number): void;
  /** Reports processed characters; ACKs are batched (≥ 5,000 chars). */
  processed(chars: number): void;
  dispose(): void;
}

interface ViewEntry {
  handlers: PtyViewHandlers;
  cols?: number;
  rows?: number;
  lastSeq: number;
  unacked: number;
}

/**
 * The renderer end of the direct MessagePort to the PTY Host. A new port (after a renderer reload or a
 * PTY Host restart) re-attaches every view: the host replies with a fresh snapshot.
 */
export class PtyChannel {
  private port: MessagePort | null = null;
  private readonly views = new Map<string, ViewEntry>();

  constructor(target: Window) {
    target.addEventListener('message', (event: MessageEvent) => {
      // Only the preload (same window) may hand over the port — never a plugin iframe.
      if (event.source !== target || (event.data as { type?: unknown } | null)?.type !== 'oxy:pty-port') return;
      const port = event.ports[0];
      if (port) this.setPort(port);
    });
  }

  get connected(): boolean {
    return this.port !== null;
  }

  private setPort(port: MessagePort): void {
    this.port?.close();
    this.port = port;
    port.onmessage = (e: MessageEvent) => this.handle(e.data as PtyToRenderer);
    port.start();
    for (const [id, view] of this.views) {
      view.lastSeq = -1;
      view.unacked = 0;
      this.post({ t: 'attach', id, ...(view.cols && view.rows ? { cols: view.cols, rows: view.rows } : {}) });
    }
  }

  private post(message: RendererToPty): void {
    this.port?.postMessage(message);
  }

  private handle(message: PtyToRenderer): void {
    const view = this.views.get(message.id);
    if (!view) return;
    switch (message.t) {
      case 'snapshot':
        view.lastSeq = message.seq;
        view.handlers.onSnapshot(message);
        break;
      case 'data':
        // Drop anything already contained in the snapshot (races around re-attach).
        if (message.seq <= view.lastSeq) return;
        view.lastSeq = message.seq;
        view.handlers.onData(message.data, message.seq);
        break;
      case 'exit':
        view.handlers.onExit(message.exitCode, message.signal);
        break;
      case 'error':
        view.handlers.onError(message.code, message.message);
        break;
    }
  }

  subscribe(id: string, handlers: PtyViewHandlers, cols?: number, rows?: number): PtySubscription {
    const view: ViewEntry = { handlers, lastSeq: -1, unacked: 0, ...(cols ? { cols } : {}), ...(rows ? { rows } : {}) };
    this.views.set(id, view);
    this.post({ t: 'attach', id, ...(cols && rows ? { cols, rows } : {}) });
    return {
      input: (data) => this.post({ t: 'input', id, data }),
      binary: (data) => this.post({ t: 'binary', id, data }),
      resize: (c, r) => {
        view.cols = c;
        view.rows = r;
        this.post({ t: 'resize', id, cols: c, rows: r });
      },
      processed: (chars) => {
        view.unacked += chars;
        if (view.unacked >= ACK_BATCH_CHARS) {
          this.post({ t: 'ack', id, chars: view.unacked });
          view.unacked = 0;
        }
      },
      dispose: () => {
        if (this.views.get(id) !== view) return;
        this.views.delete(id);
        if (view.unacked > 0) this.post({ t: 'ack', id, chars: view.unacked });
        this.post({ t: 'detach', id });
      },
    };
  }
}

let instance: PtyChannel | null = null;
export function ptyChannel(): PtyChannel {
  instance ??= new PtyChannel(window);
  return instance;
}
