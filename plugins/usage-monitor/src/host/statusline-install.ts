import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { STATUSLINE_DATA_FILE } from './collectors/claude-statusline';

/** Folder (inside the Claude configuration folder) with the status line script, its data and the backup. */
export const STATUSLINE_DIR_NAME = 'oxytocin-statusline';
const SH_SCRIPT = 'statusline.sh';
const PS_SCRIPT = 'statusline.ps1';
/** The user's previous status line command, run by the script after it saved the input. */
const ORIGINAL_COMMAND = 'original-command';
/** The user's previous `statusLine` value, restored on removal. */
const BACKUP = 'original.json';

export interface StatusLinePaths {
  /** Claude Code's `settings.json` (user scope). */
  settingsFile: string;
  /** Folder with the script, the data file and the backup. */
  dir: string;
}

/** The first folder of `CLAUDE_CONFIG_DIR` or `~/.claude`, like Claude Code. */
export function statusLinePaths(env: NodeJS.ProcessEnv, home: string = homedir()): StatusLinePaths {
  const configDir = (env['CLAUDE_CONFIG_DIR'] ?? '')
    .split(',')
    .map((d) => d.trim())
    .find(Boolean);
  const root = configDir ?? join(home, '.claude');
  return { settingsFile: join(root, 'settings.json'), dir: join(root, STATUSLINE_DIR_NAME) };
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * Whether Claude Code on Windows runs status line commands through Git Bash (it does when Git Bash is installed,
 * otherwise PowerShell): `CLAUDE_CODE_GIT_BASH_PATH`, Git on PATH or the default Git folders.
 * Always uses Windows paths, so it behaves the same when tested on Linux or macOS.
 */
export async function findGitBash(env: NodeJS.ProcessEnv, isFile = exists): Promise<string | null> {
  const candidates: string[] = [];
  if (env['CLAUDE_CODE_GIT_BASH_PATH']) candidates.push(env['CLAUDE_CODE_GIT_BASH_PATH']);
  for (const dir of (env['PATH'] ?? env['Path'] ?? '').split(win32.delimiter).filter(Boolean)) {
    if (await isFile(win32.join(dir, 'git.exe')))
      candidates.push(win32.join(dir, '..', 'bin', 'bash.exe'), win32.join(dir, 'bash.exe'));
  }
  for (const root of [
    env['ProgramFiles'],
    env['ProgramFiles(x86)'],
    env['LOCALAPPDATA'] && win32.join(env['LOCALAPPDATA'], 'Programs'),
  ])
    if (root) candidates.push(win32.join(root, 'Git', 'bin', 'bash.exe'));
  for (const c of candidates) if (await isFile(c)) return c;
  return null;
}

/** Forward slashes: Git Bash drops unquoted backslashes, PowerShell accepts both. */
const slashes = (path: string) => path.replace(/\\/g, '/');
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function shScript(dir: string): string {
  return `#!/bin/sh
# Written by Oxytocin (Usage Monitor). Saves Claude Code's status line input when it carries the subscription's
# rate limits (5-hour and weekly) so Oxytocin can show them, then runs your previous status line command.
# Turn it off in Oxytocin: Usage dashboard > Pricing > Claude subscription limits.
input=$(cat)
data=${shQuote(slashes(join(dir, STATUSLINE_DATA_FILE)))}
case "$input" in
  *'"rate_limits"'*) printf '%s' "$input" > "$data.$$.tmp" 2>/dev/null && mv -f "$data.$$.tmp" "$data" 2>/dev/null ;;
esac
original=${shQuote(slashes(join(dir, ORIGINAL_COMMAND)))}
if [ -s "$original" ]; then
  printf '%s' "$input" | eval "$(cat "$original")"
fi
`;
}

export function psScript(dir: string): string {
  return `# Written by Oxytocin (Usage Monitor). Saves Claude Code's status line input when it carries the subscription's
# rate limits (5-hour and weekly) so Oxytocin can show them, then runs your previous status line command.
# Turn it off in Oxytocin: Usage dashboard > Pricing > Claude subscription limits.
$ErrorActionPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding $false
try { [Console]::InputEncoding = $utf8; [Console]::OutputEncoding = $utf8 } catch {}
$OutputEncoding = $utf8
$in = [Console]::In.ReadToEnd()
$data = ${psQuote(join(dir, STATUSLINE_DATA_FILE))}
if ($in.Contains('"rate_limits"')) {
  try {
    $tmp = "$data.$PID.tmp"
    [IO.File]::WriteAllText($tmp, $in, $utf8)
    Move-Item -LiteralPath $tmp -Destination $data -Force
  } catch {}
}
$original = ${psQuote(join(dir, ORIGINAL_COMMAND))}
if (Test-Path -LiteralPath $original) {
  $command = [IO.File]::ReadAllText($original).Trim()
  # Encoded: Windows PowerShell drops quotes inside arguments of native commands.
  if ($command) {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $in | powershell -NoProfile -EncodedCommand $encoded
  }
}
`;
}

/** The `statusLine.command` for the script (`sh` where Claude Code uses a POSIX shell, else PowerShell). */
export function statusLineCommand(dir: string, shell: 'sh' | 'powershell'): string {
  return shell === 'sh'
    ? `sh ${shQuote(slashes(join(dir, SH_SCRIPT)))}`
    : `powershell -NoProfile -ExecutionPolicy Bypass -File "${slashes(join(dir, PS_SCRIPT))}"`;
}

interface StatusLineSetting {
  type?: unknown;
  command?: unknown;
  padding?: unknown;
  refreshInterval?: unknown;
  [key: string]: unknown;
}

/** Our own entry: its command runs a script from the Oxytocin status line folder. */
export function isOxytocinStatusLine(value: unknown): boolean {
  const command = (value as StatusLineSetting | undefined)?.command;
  return typeof command === 'string' && command.includes(STATUSLINE_DIR_NAME);
}

async function readSettings(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  if (!text.trim()) return {};
  const json = JSON.parse(text) as unknown;
  if (typeof json !== 'object' || json === null || Array.isArray(json))
    throw new Error(`${file} does not contain a JSON object`);
  return json as Record<string, unknown>;
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.oxytocin-${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

const writeSettings = (file: string, settings: Record<string, unknown>) =>
  writeAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);

/** Whether Claude Code's settings currently run our status line script. */
export async function isStatusLineInstalled(paths: StatusLinePaths): Promise<boolean> {
  try {
    return isOxytocinStatusLine((await readSettings(paths.settingsFile))['statusLine']);
  } catch {
    return false;
  }
}

/**
 * Points Claude Code's `statusLine` at our script. A previous status line keeps working: the script runs its
 * command after saving the input, and its settings (padding, refresh interval) move over. The previous value is
 * backed up once for {@link uninstallStatusLine}. An unreadable `settings.json` is never overwritten.
 */
export async function installStatusLine(paths: StatusLinePaths, shell: 'sh' | 'powershell'): Promise<void> {
  const settings = await readSettings(paths.settingsFile);
  await mkdir(paths.dir, { recursive: true });
  await writeFile(join(paths.dir, SH_SCRIPT), shScript(paths.dir), { mode: 0o755 });
  await writeFile(join(paths.dir, PS_SCRIPT), psScript(paths.dir));
  const current = settings['statusLine'] as StatusLineSetting | undefined;
  if (!isOxytocinStatusLine(current)) {
    await writeAtomic(join(paths.dir, BACKUP), `${JSON.stringify({ statusLine: current ?? null }, null, 2)}\n`);
    const original = current?.type === 'command' && typeof current.command === 'string' ? current.command : '';
    await writeAtomic(join(paths.dir, ORIGINAL_COMMAND), original);
  }
  const previous = isOxytocinStatusLine(current) ? {} : (current ?? {});
  const next: StatusLineSetting = { type: 'command', command: statusLineCommand(paths.dir, shell) };
  if (previous.padding !== undefined) next.padding = previous.padding;
  if (previous.refreshInterval !== undefined) next.refreshInterval = previous.refreshInterval;
  const merged = isOxytocinStatusLine(current) ? { ...current, command: next.command } : next;
  if (JSON.stringify(merged) === JSON.stringify(current)) return;
  await writeSettings(paths.settingsFile, { ...settings, statusLine: merged });
}

/**
 * Restores the status line from the backup when ours is still configured (a status line the user set since is
 * left alone) and removes the backup. Returns whether `settings.json` changed.
 */
export async function uninstallStatusLine(paths: StatusLinePaths): Promise<boolean> {
  const backupFile = join(paths.dir, BACKUP);
  const hasBackup = await exists(backupFile);
  let settings: Record<string, unknown>;
  try {
    settings = await readSettings(paths.settingsFile);
  } catch (e) {
    // Nothing of ours to undo: an unreadable settings file is not our business.
    if (!hasBackup) return false;
    throw e;
  }
  let changed = false;
  if (isOxytocinStatusLine(settings['statusLine'])) {
    let original: unknown = null;
    try {
      original = (JSON.parse(await readFile(backupFile, 'utf8')) as { statusLine?: unknown }).statusLine ?? null;
    } catch {
      // A damaged backup: remove our entry without restoring.
    }
    const next = { ...settings };
    if (original) next['statusLine'] = original;
    else delete next['statusLine'];
    await writeSettings(paths.settingsFile, next);
    changed = true;
  }
  await rm(backupFile, { force: true });
  await rm(join(paths.dir, ORIGINAL_COMMAND), { force: true });
  return changed;
}
