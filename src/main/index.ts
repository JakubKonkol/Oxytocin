import { app, type BrowserWindow, session, utilityProcess } from 'electron';
import { appPaths } from './app/paths';
import { registerAppProtocol, registerPrivilegedSchemes } from './app/protocols';
import { installPermissionHandlers } from './app/security';
import { resolveUserDataOverride } from './app/user-data';
import { createMainWindow } from './app/window-manager';

const userDataOverride = resolveUserDataOverride(process.argv, process.env);
if (userDataOverride) app.setPath('userData', userDataOverride);

// The single-instance lock is scoped to the userData directory, so isolated profiles can run side by side.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

registerPrivilegedSchemes();

let mainWindow: BrowserWindow | null = null;

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

function startHosts(): void {
  const hosts = [
    { name: 'ptyHost', serviceName: 'Oxytocin PTY Host' },
    { name: 'workspaceHost', serviceName: 'Oxytocin Workspace Host' },
    { name: 'pluginHost', serviceName: 'Oxytocin Plugin Host' },
  ] as const;
  for (const host of hosts) {
    const child = utilityProcess.fork(appPaths.hostEntry(host.name), [], {
      serviceName: host.serviceName,
      stdio: 'pipe',
    });
    child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[${host.serviceName}] ${chunk.toString()}`));
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[${host.serviceName}] ${chunk.toString()}`));
  }
}

void app.whenReady().then(() => {
  installPermissionHandlers(session.defaultSession);
  registerAppProtocol(session.defaultSession);
  startHosts();
  mainWindow = createMainWindow();
  mainWindow.on('closed', () => (mainWindow = null));
});

app.on('window-all-closed', () => app.quit());
