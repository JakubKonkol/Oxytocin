import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: true }, BrowserWindow: class {} }));

const { isTrustedShellUrl } = await import('./window-manager');

describe('isTrustedShellUrl', () => {
  it('trusts only the app://oxytocin origin in production', () => {
    expect(isTrustedShellUrl('app://oxytocin/index.html')).toBe(true);
    expect(isTrustedShellUrl('app://evil/index.html')).toBe(false);
    expect(isTrustedShellUrl('oxy-plugin://oxytocin/index.html')).toBe(false);
    expect(isTrustedShellUrl('https://example.com/')).toBe(false);
    expect(isTrustedShellUrl('not a url')).toBe(false);
  });
});
