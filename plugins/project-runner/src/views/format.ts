import type { RunSnapshot } from '../shared/types';

/** "running", "failed (exit 1)", "stopped"… for a profile's run. */
export function statusLabel(run: Pick<RunSnapshot, 'status' | 'exitCode'>): string {
  switch (run.status) {
    case 'idle':
      return '';
    case 'failed':
      return run.exitCode !== undefined ? `failed (exit ${run.exitCode})` : 'failed';
    default:
      return run.status;
  }
}

/** Environment variables as `KEY=value` lines for the form. */
export function formatEnv(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}
