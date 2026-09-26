import { protocol, type Session } from 'electron';
import { buildShellCsp } from '@shared/security/csp';
import { createStaticFileHandler } from './app-protocol-handler';
import { appPaths } from './paths';

export const APP_SCHEME = 'app';
export const APP_HOST = 'oxytocin';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const PLUGIN_SCHEME = 'oxy-plugin';

/** Must run before `app.whenReady()`. */
export function registerPrivilegedSchemes(): void {
  const privileges = { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true };
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges },
    { scheme: PLUGIN_SCHEME, privileges },
  ]);
}

export function registerAppProtocol(session: Session): void {
  session.protocol.handle(
    APP_SCHEME,
    createStaticFileHandler({
      rootDir: appPaths.rendererDir,
      host: APP_HOST,
      htmlHeaders: { 'Content-Security-Policy': buildShellCsp({ dev: false }) },
    }),
  );
}
