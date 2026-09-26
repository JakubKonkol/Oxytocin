export type UiPlatform = 'win32' | 'darwin' | 'linux';

/** Platform of the host OS (falls back to the user agent outside Electron, e.g. in jsdom tests). */
export function currentPlatform(): UiPlatform {
  const fromPreload =
    typeof window !== 'undefined' ? (window as { oxy?: { platform?: UiPlatform } }).oxy?.platform : undefined;
  if (fromPreload) return fromPreload;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Mac/i.test(ua)) return 'darwin';
  if (/Win/i.test(ua)) return 'win32';
  return 'linux';
}
