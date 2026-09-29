import type { UpdateState } from '@shared/domain/updates';

export interface UpdateStatusView {
  /** `failed`: the download of a newer version failed (a failed check only shows in the tooltip). */
  kind: 'version' | 'progress' | 'ready' | 'failed';
  text: string;
  title: string;
}

function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} h ago`;
}

/** The status bar entry: the version, download progress, or "Restart to update". */
export function updateStatusView(state: UpdateState, now: number): UpdateStatusView {
  const version = `v${state.currentVersion}`;
  if (state.status === 'ready')
    return {
      kind: 'ready',
      text: 'Restart to update',
      title: `Oxytocin ${state.version ?? ''} is ready. Install it now, or it installs when you quit.`,
    };
  if (state.status === 'downloading')
    return {
      kind: 'progress',
      text: `Updating… ${state.percent ?? 0}%`,
      title: `Downloading Oxytocin ${state.version ?? ''}. Click for details.`,
    };
  if (state.status === 'error' && state.version)
    return {
      kind: 'failed',
      text: 'Update failed',
      title: `Downloading Oxytocin ${state.version} failed: ${state.error ?? 'unknown error'}. Click to retry.`,
    };
  if (state.disabledReason)
    return { kind: 'version', text: version, title: `Oxytocin ${version}. ${state.disabledReason}` };
  const detail =
    state.status === 'checking'
      ? 'Checking for updates…'
      : state.status === 'error'
        ? `The last update check failed: ${state.error ?? 'unknown error'}.`
        : state.status === 'up-to-date' && state.lastCheck !== undefined
          ? `Up to date (checked ${ago(now - state.lastCheck)}).`
          : 'Click to check for updates.';
  return { kind: 'version', text: version, title: `Oxytocin ${version}. ${detail}` };
}

const UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/** 1536 → "1.5 KB", 118877001 → "113.4 MB". */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`;
}

export type UpdatePanelAction = 'install-now' | 'install-on-quit' | 'retry';

/** The popover of the status bar entry: download progress, then "Install now" / "On restart", or a retry. */
export interface UpdatePanelView {
  title: string;
  description?: string;
  /** 0–100 while downloading. */
  percent?: number;
  /** "12.3 MB of 113.4 MB · 8.0 MB/s" */
  detail?: string;
  actions: UpdatePanelAction[];
  tone: 'info' | 'success' | 'error';
}

export function updatePanelView(state: UpdateState): UpdatePanelView {
  const version = state.version ?? '';
  if (state.disabledReason)
    return { title: `Oxytocin ${state.currentVersion}`, description: state.disabledReason, actions: [], tone: 'info' };
  switch (state.status) {
    case 'downloading': {
      const parts: string[] = [];
      if (state.transferred !== undefined && state.total)
        parts.push(`${formatBytes(state.transferred)} of ${formatBytes(state.total)}`);
      if (state.bytesPerSecond) parts.push(`${formatBytes(state.bytesPerSecond)}/s`);
      return {
        title: `Downloading Oxytocin ${version}`,
        description: 'You can keep working while it downloads.',
        percent: state.percent ?? 0,
        ...(parts.length > 0 ? { detail: parts.join(' · ') } : {}),
        actions: [],
        tone: 'info',
      };
    }
    case 'ready':
      return {
        title: `Oxytocin ${version} is ready to install`,
        description: 'Install it now (Oxytocin restarts), or it installs the next time you quit Oxytocin.',
        actions: ['install-now', 'install-on-quit'],
        tone: 'success',
      };
    case 'error':
      return state.version
        ? {
            title: `Could not download Oxytocin ${version}`,
            description: state.error ?? 'Unknown error',
            actions: ['retry'],
            tone: 'error',
          }
        : {
            title: 'Could not check for updates',
            description: state.error ?? 'Unknown error',
            actions: ['retry'],
            tone: 'error',
          };
    case 'checking':
      return { title: 'Checking for updates…', actions: [], tone: 'info' };
    default:
      return { title: `Oxytocin ${state.currentVersion} is the latest version.`, actions: [], tone: 'success' };
  }
}

export interface CheckMessage {
  kind: 'info' | 'success' | 'error';
  message: string;
  description?: string;
}

/** Feedback for a check the user started ("Check for Updates"). A ready update has its own toast. */
export function manualCheckMessage(state: UpdateState): CheckMessage | null {
  if (state.disabledReason) return { kind: 'info', message: state.disabledReason };
  switch (state.status) {
    case 'up-to-date':
      return { kind: 'success', message: `Oxytocin ${state.currentVersion} is the latest version.` };
    case 'downloading':
      return {
        kind: 'info',
        message: `Downloading Oxytocin ${state.version ?? ''}…`,
        description: 'You can keep working; it installs when you restart.',
      };
    case 'error':
      return { kind: 'error', message: 'Could not check for updates', description: state.error };
    default:
      return null;
  }
}
