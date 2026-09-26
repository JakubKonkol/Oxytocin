import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/globals.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installTestHooks } from './lib/test-hooks';
import { ptyChannel } from './features/terminals/pty-channel';
import { registerTerminalCommands } from './features/terminals/terminal-actions';
import { installGlobalKeybindings } from './lib/keyboard';
import { registerLayoutCommands } from './features/layout/layout-commands';

if (window.oxy.e2e) {
  document.documentElement.dataset['e2e'] = 'true';
  installTestHooks();
}
document.documentElement.dataset['theme'] = 'dark';
// Listen for the PTY MessagePort before main sends it (did-finish-load).
ptyChannel();
registerTerminalCommands();
registerLayoutCommands();
installGlobalKeybindings();

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
