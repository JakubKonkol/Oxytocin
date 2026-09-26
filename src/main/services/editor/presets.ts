export type EditorPresetId =
  'vscode' | 'cursor' | 'windsurf' | 'zed' | 'jetbrains' | 'sublime' | 'notepadpp' | 'terminal' | 'system' | 'custom';

export interface EditorPreset {
  id: EditorPresetId;
  name: string;
  /** Launchers tried in order (on PATH, or absolute paths). */
  launchers: string[];
  /** Arguments after the launcher. */
  args: string[];
}

/** docs/plan/09-persistence-settings.md §4 */
export const EDITOR_PRESETS: EditorPreset[] = [
  { id: 'vscode', name: 'VS Code', launchers: ['code'], args: ['--goto', '${file}:${line}:${column}'] },
  { id: 'cursor', name: 'Cursor', launchers: ['cursor'], args: ['--goto', '${file}:${line}:${column}'] },
  { id: 'windsurf', name: 'Windsurf', launchers: ['windsurf'], args: ['--goto', '${file}:${line}:${column}'] },
  { id: 'zed', name: 'Zed', launchers: ['zed'], args: ['${file}:${line}:${column}'] },
  {
    id: 'jetbrains',
    name: 'JetBrains',
    launchers: ['idea', 'webstorm', 'pycharm', 'rider', 'goland', 'phpstorm', 'clion', 'rubymine', 'rustrover'],
    args: ['--line', '${line}', '--column', '${column}', '${file}'],
  },
  { id: 'sublime', name: 'Sublime Text', launchers: ['subl'], args: ['${file}:${line}:${column}'] },
  {
    id: 'notepadpp',
    name: 'Notepad++',
    launchers: [
      'notepad++',
      'C:\\Program Files\\Notepad++\\notepad++.exe',
      'C:\\Program Files (x86)\\Notepad++\\notepad++.exe',
    ],
    args: ['-n${line}', '-c${column}', '${file}'],
  },
];

/** `auto` order: VS Code → Cursor → Windsurf → Zed → JetBrains → Sublime → system default. */
export const AUTO_ORDER: EditorPresetId[] = ['vscode', 'cursor', 'windsurf', 'zed', 'jetbrains', 'sublime'];
