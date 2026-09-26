/**
 * A command line for display: the executable is reduced to its base name without `.exe`
 * (`"C:\Program Files\nodejs\node.exe" -e …` → `node -e …`, `/usr/bin/python3 app.py` → `python3 app.py`).
 */
export function displayCommandLine(commandLine: string): string {
  const trimmed = commandLine.trim();
  const m = /^(?:"([^"]+)"|(\S+))(.*)$/s.exec(trimmed);
  if (!m) return trimmed;
  const exe = (m[1] ?? m[2] ?? '').split(/[\\/]/).at(-1) ?? '';
  return `${exe.replace(/\.(exe|cmd|bat|com)$/i, '')}${m[3] ?? ''}`;
}
