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
