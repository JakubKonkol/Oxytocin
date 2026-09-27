import { connect, type OxyView } from '@oxytocin/plugin-sdk';
import '@oxytocin/plugin-sdk/theme.css';
import './setup.css';
import type { ActionResult, BridgeStatus } from '../shared/status';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const buttons = ['install', 'uninstall', 'refresh'].map((id) => $<HTMLButtonElement>(id));
const [installButton, uninstallButton, refreshButton] = buttons as [
  HTMLButtonElement,
  HTMLButtonElement,
  HTMLButtonElement,
];
const output = $<HTMLPreElement>('output');

function render(s: BridgeStatus): void {
  $('endpoint').textContent = `http://127.0.0.1:${s.port}`;
  $('cli-preview').textContent = `${s.claudeCommand} plugin install oxytocin-bridge@oxytocin`;
  $('status-endpoint').textContent = s.listening ? `listening on 127.0.0.1:${s.port}` : (s.error ?? 'not listening');
  $('status-installed').textContent =
    s.installed === true
      ? 'the bridge is installed'
      : s.installed === false
        ? 'not installed'
        : `could not check (is "${s.claudeCommand}" installed?)`;
  $('status-events').textContent =
    s.events === 0
      ? 'none received yet'
      : `${s.events} received, last at ${new Date(s.lastEventAt ?? 0).toLocaleTimeString()}`;
  document.body.dataset['installed'] = String(s.installed);
  installButton.textContent = s.installed ? 'Reinstall in Claude Code' : 'Install in Claude Code';
  uninstallButton.disabled = s.installed === false;
}

async function busy(view: OxyView, work?: () => Promise<void>): Promise<void> {
  for (const b of buttons) b.disabled = true;
  try {
    await work?.();
  } catch (e) {
    output.hidden = false;
    output.textContent = e instanceof Error ? e.message : String(e);
  } finally {
    for (const b of buttons) b.disabled = false;
    render(await view.request<BridgeStatus>('status'));
  }
}

function showResult(result: ActionResult, success: string): void {
  output.hidden = false;
  output.dataset['ok'] = String(result.ok);
  output.textContent = result.ok ? `${success}\n${result.output}`.trim() : `Failed:\n${result.output}`;
}

void connect().then((view) => {
  $('docs').addEventListener('click', (e) => {
    e.preventDefault();
    void view.openExternal('https://code.claude.com/docs/en/hooks');
  });
  installButton.addEventListener(
    'click',
    () =>
      void busy(view, async () =>
        showResult(await view.request<ActionResult>('install', undefined, { timeoutMs: 120_000 }), 'Installed.'),
      ),
  );
  uninstallButton.addEventListener(
    'click',
    () =>
      void busy(view, async () =>
        showResult(await view.request<ActionResult>('uninstall', undefined, { timeoutMs: 120_000 }), 'Removed.'),
      ),
  );
  refreshButton.addEventListener('click', () => void busy(view));
  void busy(view);
});
