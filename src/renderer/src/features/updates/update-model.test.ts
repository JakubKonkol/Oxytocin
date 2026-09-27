import { describe, expect, it } from 'vitest';
import type { UpdateState } from '@shared/domain/updates';
import { manualCheckMessage, updateStatusView } from './update-model';

const base: UpdateState = { currentVersion: '0.1.0', status: 'idle' };

describe('updateStatusView', () => {
  it('shows the version with the check result in the tooltip', () => {
    expect(updateStatusView(base, 0)).toMatchObject({ kind: 'version', text: 'v0.1.0' });
    expect(updateStatusView({ ...base, status: 'up-to-date', lastCheck: 0 }, 5 * 60_000).title).toContain(
      'checked 5 min ago',
    );
    expect(updateStatusView({ ...base, status: 'error', error: 'offline' }, 0).title).toContain('failed: offline');
    expect(updateStatusView({ ...base, disabledReason: 'Dev build.' }, 0).title).toBe('Oxytocin v0.1.0. Dev build.');
  });

  it('shows download progress and a ready update', () => {
    expect(updateStatusView({ ...base, status: 'downloading', version: '0.2.0', percent: 42 }, 0)).toMatchObject({
      kind: 'progress',
      text: 'Updating… 42%',
    });
    expect(updateStatusView({ ...base, status: 'ready', version: '0.2.0' }, 0)).toMatchObject({
      kind: 'ready',
      text: 'Restart to update',
    });
  });
});

describe('manualCheckMessage', () => {
  it('reports the result of a check the user started', () => {
    expect(manualCheckMessage({ ...base, status: 'up-to-date' })).toMatchObject({
      kind: 'success',
      message: 'Oxytocin 0.1.0 is the latest version.',
    });
    expect(manualCheckMessage({ ...base, status: 'downloading', version: '0.2.0' })?.message).toBe(
      'Downloading Oxytocin 0.2.0…',
    );
    expect(manualCheckMessage({ ...base, status: 'error', error: 'offline' })).toMatchObject({
      kind: 'error',
      description: 'offline',
    });
    expect(manualCheckMessage({ ...base, disabledReason: 'Dev build.' })).toEqual({
      kind: 'info',
      message: 'Dev build.',
    });
    expect(manualCheckMessage({ ...base, status: 'ready', version: '0.2.0' })).toBeNull();
  });
});
