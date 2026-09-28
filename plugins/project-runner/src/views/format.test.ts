import { describe, expect, it } from 'vitest';
import { formatEnv, statusLabel } from './format';

describe('view format', () => {
  it('labels run states', () => {
    expect(statusLabel({ status: 'idle' })).toBe('');
    expect(statusLabel({ status: 'running' })).toBe('running');
    expect(statusLabel({ status: 'failed', exitCode: 1 })).toBe('failed (exit 1)');
    expect(statusLabel({ status: 'failed' })).toBe('failed');
  });

  it('formats environment variables as lines', () => {
    expect(formatEnv({ PORT: '4000', DEBUG: 'app:*' })).toBe('PORT=4000\nDEBUG=app:*');
    expect(formatEnv(undefined)).toBe('');
  });
});
