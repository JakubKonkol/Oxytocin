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
import { registerMainConfirmRequests } from './stores/dialog-store';
import { flushUiState } from './stores/ui-store';
import { registerKeybindingCommands } from './features/keybindings/KeybindingsPanel';
import { registerSettingsCommands } from './features/settings/SettingsPanel';
import { registerProjectSettingsCommands } from './features/projects/ProjectSettingsDialog';
import { flushAllWorkspaces } from './features/layout/persistence';
import { saveAllUnsaved, unsavedFiles } from './features/layout/unsaved-registry';
import { registerUpdateCommands } from './features/updates/update-store';
import { registerEnsembleCommands } from './features/ensemble/ensemble-actions';
import { registerEditorCommands } from './features/editor/editor-actions';
import { registerReviewCommands } from './features/review/review-actions';

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
registerMainConfirmRequests();
registerKeybindingCommands();
registerSettingsCommands();
registerProjectSettingsCommands();
registerUpdateCommands();
registerEnsembleCommands();
registerEditorCommands();
registerReviewCommands();
installGlobalKeybindings();
// Called by main while quitting: layouts plus the debounced UI state (scratchpad text).
(window as unknown as { __oxyFlushWorkspaces: () => Promise<void> }).__oxyFlushWorkspaces = async () => {
  await Promise.all([flushAllWorkspaces(), flushUiState()]);
};
// Asked by main before quitting: files with unsaved edits in code editors and edited diffs.
Object.assign(window, { __oxyUnsavedFiles: unsavedFiles, __oxySaveAll: saveAllUnsaved });

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
