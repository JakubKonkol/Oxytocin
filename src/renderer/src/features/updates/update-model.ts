import type { UpdateState } from '@shared/domain/updates';

export interface UpdateStatusView {
  kind: 'version' | 'progress' | 'ready';
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
      title: `Oxytocin ${state.version ?? ''} is ready. Restart now, or it installs when you quit.`,
    };
  if (state.status === 'downloading')
    return {
      kind: 'progress',
      text: `Updating… ${state.percent ?? 0}%`,
      title: `Downloading Oxytocin ${state.version ?? ''}`,
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
