import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/globals.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installTestHooks } from './lib/test-hooks';
import { buildXtermTheme, installThemeController, onDidChangeTheme, setThemeSetting } from './lib/theme';
import { useSettingsStore } from './stores/settings-store';
import { terminalRegistry } from './features/terminals/terminal-registry';
import { ptyChannel } from './features/terminals/pty-channel';
import { registerTerminalCommands } from './features/terminals/terminal-actions';
import { installGlobalKeybindings } from './lib/keyboard';
import { registerLayoutCommands } from './features/layout/layout-commands';
import { registerProjectCommands } from './features/projects/project-actions';
import { registerAttentionCommands } from './features/attention/attention';
import { registerDiffCommands } from './features/diff/diff-actions';
import { syncPluginCommands } from './features/plugins/plugin-commands';
import { registerPluginManagerCommands } from './features/plugins/plugin-manager';
import { registerHelpCommands } from './features/help/HelpDialogs';
import { registerPaletteCommands } from './features/palette/palette-store';
import { registerKeybindingCommands } from './features/keybindings/KeybindingsPanel';
import { registerSettingsCommands } from './features/settings/SettingsPanel';
import { flushAllWorkspaces } from './features/layout/persistence';

if (window.oxy.e2e) {
  document.documentElement.dataset['e2e'] = 'true';
  installTestHooks();
}
installThemeController();
useSettingsStore.subscribe((s) => {
  if (s.settings) setThemeSetting(s.settings['appearance.theme']);
});
// Terminals re-read the ANSI palette from the swapped tokens.
onDidChangeTheme(() => {
  const theme = buildXtermTheme();
  for (const entry of terminalRegistry.values()) entry.term.options.theme = theme;
});
// Listen for the PTY MessagePort before main sends it (did-finish-load).
ptyChannel();
registerTerminalCommands();
registerLayoutCommands();
registerProjectCommands();
registerAttentionCommands();
registerDiffCommands();
syncPluginCommands();
registerPluginManagerCommands();
registerHelpCommands();
registerPaletteCommands();
registerKeybindingCommands();
registerSettingsCommands();
installGlobalKeybindings();
(window as unknown as { __oxyFlushWorkspaces: () => Promise<void> }).__oxyFlushWorkspaces = flushAllWorkspaces;

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
