import { type App, shell, type Session, type WebContents, type WebPreferences } from 'electron';

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

export function secureWebPreferences(preload: string): WebPreferences {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    spellcheck: false,
    webviewTag: false,
  };
}

export function isSafeExternalUrl(raw: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(raw).protocol);
  } catch {
    return false;
  }
}

/** Blocks navigation away from the shell origin and routes window.open to the OS browser. */
export function hardenWebContents(contents: WebContents, isTrustedOrigin: (url: string) => boolean): void {
  contents.on('will-navigate', (event, url) => {
    if (!isTrustedOrigin(url)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!isTrustedOrigin(url)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

export function installPermissionHandlers(session: Session): void {
  session.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  session.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
}

/**
 * Defense in depth for every web contents the app ever creates (the shell window, DevTools, anything added later):
 * no `<webview>` and no new Electron windows; http(s)/mailto links open in the OS browser instead.
 */
export function hardenNewWebContents(electronApp: Pick<App, 'on'>): void {
  electronApp.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
  });
}
