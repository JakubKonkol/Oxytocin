import { describe, expect, it } from 'vitest';
import type { DetectDeps } from './deps';
import { which } from './deps';
import { detectAgentProfiles } from './agents';
import { detectPosixProfiles, parseEtcShells } from './posix';
import { decodeWslList, detectWindowsProfiles, parseRegQueryValue } from './win';

function fakeDeps(opts: {
  platform: NodeJS.Platform;
  env: Record<string, string>;
  files: string[];
  texts?: Record<string, string>;
  exec?: Record<string, Buffer>;
}): DetectDeps {
  const files = new Set(opts.files.map((f) => (opts.platform === 'win32' ? f.toLowerCase() : f)));
  return {
    platform: opts.platform,
    env: opts.env,
    isFile: (p) => Promise.resolve(files.has(opts.platform === 'win32' ? p.toLowerCase() : p)),
    readText: (p) => Promise.resolve(opts.texts?.[p] ?? null),
    exec: (file, args) => Promise.resolve(opts.exec?.[[file, ...args].join(' ')] ?? null),
  };
}

describe('Windows profile detection', () => {
  const env = {
    Path: 'C:\\Windows\\System32;C:\\Program Files\\PowerShell\\7;C:\\Users\\me\\.local\\bin',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    ProgramFiles: 'C:\\Program Files',
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  };
  const wslOutput = Buffer.from('\uFEFFUbuntu\r\ndocker-desktop\r\nDebian\r\n', 'utf16le');

  it('detects pwsh, PowerShell, cmd, Git Bash (registry) and WSL distros', async () => {
    const deps = fakeDeps({
      platform: 'win32',
      env,
      files: [
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        'C:\\Windows\\System32\\cmd.exe',
        'D:\\Git\\bin\\bash.exe',
        'C:\\Windows\\System32\\wsl.exe',
      ],
      exec: {
        'reg query HKLM\\SOFTWARE\\GitForWindows /v InstallPath': Buffer.from(
          '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\GitForWindows\r\n    InstallPath    REG_SZ    D:\\Git\r\n',
        ),
        'C:\\Windows\\System32\\wsl.exe -l -q': wslOutput,
      },
    });
    const profiles = await detectWindowsProfiles(deps);
    expect(profiles.map((p) => p.id)).toEqual(['pwsh', 'powershell', 'cmd', 'git-bash', 'wsl:Ubuntu', 'wsl:Debian']);
    expect(profiles.find((p) => p.id === 'git-bash')?.file).toBe('D:\\Git\\bin\\bash.exe');
    expect(profiles.find((p) => p.id === 'wsl:Ubuntu')?.args).toEqual(['-d', 'Ubuntu']);
  });

  it('decodes wsl output in UTF-16LE and UTF-8', () => {
    expect(decodeWslList(wslOutput)).toEqual(['Ubuntu', 'Debian']);
    expect(decodeWslList(Buffer.from('Alpine\n'))).toEqual(['Alpine']);
  });

  it('parses reg query output', () => {
    expect(parseRegQueryValue('    InstallPath    REG_SZ    C:\\Program Files\\Git', 'InstallPath')).toBe(
      'C:\\Program Files\\Git',
    );
    expect(parseRegQueryValue('nothing', 'InstallPath')).toBeNull();
  });

  it('resolves PATHEXT and case-insensitive PATH in which()', async () => {
    const deps = fakeDeps({ platform: 'win32', env, files: ['C:\\Users\\me\\.local\\bin\\claude.exe'] });
    expect(await which('claude', deps)).toBe('C:\\Users\\me\\.local\\bin\\claude.exe');
    expect(await which('codex', deps)).toBeNull();
  });

  it('checks PATH candidates concurrently but returns the first match in PATH order', async () => {
    const first = '/first/node';
    const second = '/second/node';
    let pending = 0;
    let maxPending = 0;
    const deps = {
      ...fakeDeps({ platform: 'linux', env: { PATH: '/first:/second' }, files: [] }),
      isFile: async (p: string) => {
        pending++;
        maxPending = Math.max(maxPending, pending);
        // The earlier PATH entry answers last.
        await new Promise((r) => setTimeout(r, p === first ? 20 : 0));
        pending--;
        return p === first || p === second;
      },
    };
    expect(await which('node', deps)).toBe(first);
    expect(maxPending).toBe(2);
  });
});

describe('POSIX profile detection', () => {
  it('puts $SHELL first and adds shells from /etc/shells and PATH', async () => {
    const deps = fakeDeps({
      platform: 'linux',
      env: { SHELL: '/usr/bin/zsh', PATH: '/usr/bin:/bin' },
      files: ['/usr/bin/zsh', '/bin/bash', '/usr/bin/fish'],
      texts: { '/etc/shells': '# comment\n/bin/sh\n/bin/bash\n/usr/bin/zsh\n' },
    });
    const profiles = await detectPosixProfiles(deps);
    expect(profiles.map((p) => [p.id, p.file])).toEqual([
      ['zsh', '/usr/bin/zsh'],
      ['bash', '/bin/bash'],
      ['fish', '/usr/bin/fish'],
    ]);
    expect(profiles[0]?.args).toEqual(['-l']);
  });

  it('parses /etc/shells', () => {
    expect(parseEtcShells('# x\n/bin/bash\n\n/usr/bin/fish\n')).toEqual(['/bin/bash', '/usr/bin/fish']);
  });
});

describe('agent profiles', () => {
  it('lists only agents found on PATH', async () => {
    const deps = fakeDeps({
      platform: 'linux',
      env: { PATH: '/home/me/.local/bin' },
      files: ['/home/me/.local/bin/claude'],
    });
    const agents = await detectAgentProfiles(deps);
    expect(agents).toEqual([expect.objectContaining({ id: 'agent:claude', kind: 'agent', command: 'claude' })]);
  });
});
