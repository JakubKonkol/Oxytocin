import type { ProgressState } from '@shared/domain/terminal';

export type Osc9Result =
  { kind: 'progress'; state: ProgressState; value?: number } | { kind: 'notification'; body: string } | null;

/** OSC 9: `4;<state>;<progress>` (ConEmu / Windows Terminal progress) or a plain iTerm2 notification. */
export function parseOsc9(data: string): Osc9Result {
  if (data.startsWith('4;') || data === '4') {
    const [, stateRaw, valueRaw] = data.split(';');
    const state = Number(stateRaw ?? '0');
    if (!Number.isInteger(state) || state < 0 || state > 4) return null;
    const value = valueRaw === undefined || valueRaw === '' ? undefined : Number(valueRaw);
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 100)) {
      return { kind: 'progress', state: state as ProgressState };
    }
    return value === undefined
      ? { kind: 'progress', state: state as ProgressState }
      : { kind: 'progress', state: state as ProgressState, value };
  }
  // Other numeric ConEmu sub-commands (e.g. 9;1 sleep, 9;9 cwd) are not notifications.
  if (/^\d+(;|$)/.test(data)) return null;
  return data.length > 0 ? { kind: 'notification', body: data } : null;
}

/** OSC 777: `notify;<title>;<body>` (rxvt-unicode, Ghostty, …). */
export function parseOsc777(data: string): { title?: string; body: string } | null {
  const parts = data.split(';');
  if (parts[0] !== 'notify') return null;
  const title = parts[1] ?? '';
  const body = parts.slice(2).join(';');
  if (!title && !body) return null;
  return title ? { title, body } : { body };
}

/** OSC 7: `file://<host>/<path>` → local path (Windows drive paths lose the leading slash). */
export function parseOsc7(data: string): string | null {
  if (!data.startsWith('file://')) return null;
  let url: URL;
  try {
    url = new URL(data);
  } catch {
    return null;
  }
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
  return path || null;
}

export type Osc633 =
  | { kind: 'promptStart' }
  | { kind: 'promptEnd' }
  | { kind: 'commandStart' }
  | { kind: 'commandLine'; commandLine: string }
  | { kind: 'commandEnd'; exitCode?: number }
  | { kind: 'cwd'; cwd: string };

/** Reverses the OSC 633 value escaping (`\\` → `\`, `\xNN` → the character). */
export function unescapeOsc633(value: string): string {
  return value.replace(/\\(\\|x([0-9a-fA-F]{2}))/g, (_m, all: string, hex: string | undefined) =>
    hex ? String.fromCharCode(parseInt(hex, 16)) : all,
  );
}

/**
 * OSC 633 (shell integration): `A` prompt start, `B` prompt end, `C` command
 * start, `D[;exit]` command end, `E;<command line>`, `P;Cwd=<path>`. Unknown marks are ignored.
 */
export function parseOsc633(data: string): Osc633 | null {
  const sep = data.indexOf(';');
  const mark = sep < 0 ? data : data.slice(0, sep);
  const rest = sep < 0 ? '' : data.slice(sep + 1);
  switch (mark) {
    case 'A':
      return { kind: 'promptStart' };
    case 'B':
      return { kind: 'promptEnd' };
    case 'C':
      return { kind: 'commandStart' };
    case 'D': {
      const code = rest === '' ? NaN : Number(rest.split(';')[0]);
      return Number.isInteger(code) ? { kind: 'commandEnd', exitCode: code } : { kind: 'commandEnd' };
    }
    case 'E': {
      // A nonce may follow the command line (`E;<line>;<nonce>`); escaped `;` never appears raw in the line.
      const line = rest.split(';')[0] ?? '';
      return { kind: 'commandLine', commandLine: unescapeOsc633(line) };
    }
    case 'P': {
      if (!rest.startsWith('Cwd=')) return null;
      const cwd = unescapeOsc633(rest.slice(4));
      return cwd ? { kind: 'cwd', cwd } : null;
    }
    default:
      return null;
  }
}
