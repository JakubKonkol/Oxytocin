import { describe, expect, it } from 'vitest';
import { defaultSettings, type Settings } from '@shared/domain/settings';
import type { DetectDeps } from './shell-detect/deps';
import { ProfileService, shellTypeOf } from './profiles';

const deps = (
  files: string[],
  env: Record<string, string> = { PATH: '/usr/bin:/bin', SHELL: '/bin/bash' },
): DetectDeps => ({
  platform: 'linux',
  env,
  isFile: (p) => Promise.resolve(files.includes(p)),
  readText: () => Promise.resolve('/bin/bash\n/usr/bin/zsh\n'),
  exec: () => Promise.resolve(null),
});

const settings = (over: Partial<Settings> = {}): Settings => ({ ...defaultSettings('linux'), ...over });

describe('ProfileService', () => {
  it('uses $SHELL as the default and resolves agent profiles to shell + command', async () => {
    const svc = new ProfileService(deps(['/bin/bash', '/usr/bin/zsh', '/usr/bin/claude']), () => settings());
    expect((await svc.defaultShellProfile()).id).toBe('bash');
    const launch = await svc.resolveLaunch('agent:claude', '/tmp');
    expect(launch).toMatchObject({ file: '/bin/bash', args: ['-l'], initialCommand: 'claude', shellType: 'bash' });
    expect(launch.profile).toMatchObject({ id: 'agent:claude', kind: 'agent', name: 'Claude Code' });
  });

  it('honours the configured default, user profiles and hidden profiles', async () => {
    const svc = new ProfileService(deps(['/bin/bash', '/usr/bin/zsh']), () =>
      settings({
        'terminal.defaultProfile.linux': 'zsh',
        'terminal.hiddenProfiles': ['bash'],
        'terminal.profiles': [
          { id: 'custom:node', name: 'Node REPL', kind: 'shell', file: '/usr/bin/node', args: [], source: 'user' },
        ],
      }),
    );
    expect((await svc.list()).map((p) => p.id)).toEqual(['zsh', 'custom:node']);
    expect((await svc.defaultShellProfile()).id).toBe('zsh');
  });

  it('rejects unknown profiles', async () => {
    const svc = new ProfileService(deps(['/bin/bash']), () => settings());
    await expect(svc.resolveLaunch('nope', '/tmp')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('caches detection for an hour', async () => {
    let now = 0;
    const files = ['/bin/bash'];
    const svc = new ProfileService(
      deps(files),
      () => settings(),
      () => now,
    );
    expect((await svc.list()).map((p) => p.id)).toEqual(['bash']);
    files.push('/usr/bin/zsh');
    expect((await svc.list()).map((p) => p.id)).toEqual(['bash']);
    now = 61 * 60 * 1000;
    expect((await svc.list()).map((p) => p.id)).toEqual(['bash', 'zsh']);
  });
});

describe('shellTypeOf', () => {
  it('classifies shells by id and executable', () => {
    expect(shellTypeOf({ id: 'pwsh', file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' })).toBe('pwsh');
    expect(shellTypeOf({ id: 'git-bash', file: 'C:\\Git\\bin\\bash.exe' })).toBe('git-bash');
    expect(shellTypeOf({ id: 'wsl:Ubuntu', file: 'C:\\Windows\\System32\\wsl.exe' })).toBe('wsl');
    expect(shellTypeOf({ id: 'x', file: '/usr/local/bin/fish' })).toBe('fish');
    expect(shellTypeOf({ id: 'x', file: '/usr/bin/node' })).toBe('other');
  });
});
