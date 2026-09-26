import { join } from 'node:path';
import { app, BrowserWindow, utilityProcess } from 'electron';

const HOSTS = [
  { entry: 'ptyHost.js', serviceName: 'Oxytocin PTY Host' },
  { entry: 'workspaceHost.js', serviceName: 'Oxytocin Workspace Host' },
  { entry: 'pluginHost.js', serviceName: 'Oxytocin Plugin Host' },
] as const;

function startHosts(): void {
  for (const host of HOSTS) {
    const child = utilityProcess.fork(join(__dirname, host.entry), [], {
      serviceName: host.serviceName,
      stdio: 'pipe',
    });
    child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[${host.serviceName}] ${chunk.toString()}`));
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[${host.serviceName}] ${chunk.toString()}`));
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'Oxytocin',
    backgroundColor: '#0b0d10',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(() => {
  startHosts();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
