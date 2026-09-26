import type { TerminalProfile } from '@shared/domain/terminal-profile';
import { type DetectDeps, envValue, which } from './deps';

/** `wsl.exe -l -q` prints UTF-16LE (with NULs and sometimes a BOM). */
export function decodeWslList(output: Buffer): string[] {
  let text = output.toString('utf16le');
  if (!output.includes(0)) text = output.toString('utf8');
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\0/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^docker-desktop(-data)?$/i.test(l));
}

/** Parses `reg query <key> /v InstallPath` output. */
export function parseRegQueryValue(output: string, valueName: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const m = new RegExp(`^\\s*${valueName}\\s+REG_(?:EXPAND_)?SZ\\s+(.+?)\\s*$`, 'i').exec(line);
    if (m?.[1]) return m[1];
  }
  return null;
}

export async function detectWindowsProfiles(deps: DetectDeps): Promise<TerminalProfile[]> {
  const profiles: TerminalProfile[] = [];
  const programFiles = envValue(deps, 'ProgramFiles') ?? 'C:\\Program Files';
  const systemRoot = envValue(deps, 'SystemRoot') ?? 'C:\\Windows';

  const pwsh =
    (await which('pwsh.exe', deps)) ??
    ((await deps.isFile(`${programFiles}\\PowerShell\\7\\pwsh.exe`))
      ? `${programFiles}\\PowerShell\\7\\pwsh.exe`
      : null);
  if (pwsh) {
    profiles.push({
      id: 'pwsh',
      name: 'PowerShell 7',
      kind: 'shell',
      file: pwsh,
      args: ['-NoLogo'],
      icon: 'terminal-powershell',
      source: 'detected',
    });
  }

  const powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  if (await deps.isFile(powershell)) {
    profiles.push({
      id: 'powershell',
      name: 'Windows PowerShell',
      kind: 'shell',
      file: powershell,
      args: ['-NoLogo'],
      icon: 'terminal-powershell',
      source: 'detected',
    });
  }

  const comSpec = envValue(deps, 'ComSpec') ?? `${systemRoot}\\System32\\cmd.exe`;
  if (await deps.isFile(comSpec)) {
    profiles.push({
      id: 'cmd',
      name: 'Command Prompt',
      kind: 'shell',
      file: comSpec,
      args: [],
      icon: 'terminal-cmd',
      source: 'detected',
    });
  }

  const gitCandidates = [`${programFiles}\\Git\\bin\\bash.exe`];
  const reg = await deps.exec('reg', ['query', 'HKLM\\SOFTWARE\\GitForWindows', '/v', 'InstallPath']);
  const installPath = reg ? parseRegQueryValue(reg.toString('utf8'), 'InstallPath') : null;
  if (installPath) gitCandidates.unshift(`${installPath}\\bin\\bash.exe`);
  for (const candidate of gitCandidates) {
    if (await deps.isFile(candidate)) {
      profiles.push({
        id: 'git-bash',
        name: 'Git Bash',
        kind: 'shell',
        file: candidate,
        args: ['--login', '-i'],
        icon: 'terminal-git-bash',
        source: 'detected',
      });
      break;
    }
  }

  const wslExe = `${systemRoot}\\System32\\wsl.exe`;
  if (await deps.isFile(wslExe)) {
    const list = await deps.exec(wslExe, ['-l', '-q']);
    for (const distro of list ? decodeWslList(list) : []) {
      profiles.push({
        id: `wsl:${distro}`,
        name: `WSL: ${distro}`,
        kind: 'shell',
        file: wslExe,
        args: ['-d', distro],
        icon: 'terminal-linux',
        source: 'detected',
      });
    }
  }
  return profiles;
}
