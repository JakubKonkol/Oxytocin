import { describe, expect, it } from 'vitest';
import type { UpdateState } from '@shared/domain/updates';
import { formatBytes, manualCheckMessage, updatePanelView, updateStatusView } from './update-model';

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

  it('shows a failed download, but keeps a failed check in the tooltip', () => {
    expect(updateStatusView({ ...base, status: 'error', version: '0.2.0', error: 'status 404' }, 0)).toMatchObject({
      kind: 'failed',
      text: 'Update failed',
      title: 'Downloading Oxytocin 0.2.0 failed: status 404. Click to retry.',
    });
    expect(updateStatusView({ ...base, status: 'error', error: 'offline' }, 0).kind).toBe('version');
  });
});

describe('updatePanelView', () => {
  it('shows the download progress with sizes and speed', () => {
    expect(
      updatePanelView({
        ...base,
        status: 'downloading',
        version: '0.2.0',
        percent: 42,
        transferred: 50 * 1024 * 1024,
        total: 118877001,
        bytesPerSecond: 8 * 1024 * 1024,
      }),
    ).toMatchObject({
      title: 'Downloading Oxytocin 0.2.0',
      percent: 42,
      detail: '50.0 MB of 113.4 MB · 8.0 MB/s',
      actions: [],
    });
    expect(updatePanelView({ ...base, status: 'downloading', version: '0.2.0' })).not.toHaveProperty('detail');
  });

  it('offers to install now or on restart, and to retry a failure', () => {
    expect(updatePanelView({ ...base, status: 'ready', version: '0.2.0' })).toMatchObject({
      title: 'Oxytocin 0.2.0 is ready to install',
      actions: ['install-now', 'install-on-quit'],
    });
    expect(updatePanelView({ ...base, status: 'error', version: '0.2.0', error: 'status 404' })).toMatchObject({
      title: 'Could not download Oxytocin 0.2.0',
      description: 'status 404',
      actions: ['retry'],
      tone: 'error',
    });
    expect(updatePanelView({ ...base, status: 'error', error: 'offline' })).toMatchObject({
      title: 'Could not check for updates',
      actions: ['retry'],
    });
    expect(updatePanelView({ ...base, status: 'checking' }).title).toBe('Checking for updates…');
    expect(updatePanelView({ ...base, status: 'up-to-date' }).title).toBe('Oxytocin 0.1.0 is the latest version.');
  });
});

describe('formatBytes', () => {
  it('uses binary units with one decimal', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(118877001)).toBe('113.4 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
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
