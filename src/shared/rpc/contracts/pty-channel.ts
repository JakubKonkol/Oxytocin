import type { TerminalId } from '../../domain/terminal';

/** Renderer → PTY Host messages on the direct MessagePort (docs/plan/04-terminals.md §4.1). */
export type RendererToPty =
  | { t: 'attach'; id: TerminalId; cols?: number; rows?: number }
  | { t: 'detach'; id: TerminalId }
  | { t: 'input'; id: TerminalId; data: string }
  | { t: 'binary'; id: TerminalId; data: string }
  | { t: 'resize'; id: TerminalId; cols: number; rows: number }
  | { t: 'ack'; id: TerminalId; chars: number };

/** PTY Host → renderer messages. */
export type PtyToRenderer =
  | { t: 'snapshot'; id: TerminalId; seq: number; data: string; cols: number; rows: number }
  | { t: 'data'; id: TerminalId; seq: number; data: string }
  | { t: 'exit'; id: TerminalId; exitCode: number; signal?: number }
  | { t: 'error'; id: TerminalId; code: 'NOT_FOUND' | 'DEAD'; message: string };

/** Renderer acknowledges processed output at least every ACK_BATCH_CHARS characters. */
export const ACK_BATCH_CHARS = 5_000;

export function isRendererToPty(msg: unknown): msg is RendererToPty {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as { t?: unknown; id?: unknown };
  if (typeof m.id !== 'string') return false;
  switch (m.t) {
    case 'attach':
    case 'detach':
      return true;
    case 'input':
    case 'binary':
      return typeof (msg as { data?: unknown }).data === 'string';
    case 'resize': {
      const r = msg as { cols?: unknown; rows?: unknown };
      return Number.isInteger(r.cols) && Number.isInteger(r.rows) && (r.cols as number) > 1 && (r.rows as number) > 0;
    }
    case 'ack':
      return typeof (msg as { chars?: unknown }).chars === 'number';
    default:
      return false;
  }
}
