import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { injectShellIntegration, installShellIntegration, SHELL_INTEGRATION_FILES } from './shell-integration';

const scripts = { dir: '/data/si', pwsh: 'Write-Host hi' };
const env = { HOME: '/home/me', PATH: '/bin' };

describe('injectShellIntegration', () => {
  it('bash: --init-file, and a login flag becomes an emulated login', () => {
    const r = injectShellIntegration({ shellType: 'bash', args: ['-l'], env, scripts, platform: 'linux' });
    expect(r).toEqual({
      args: ['--init-file', '/data/si/bash.sh'],
      env: { ...env, OXYTOCIN_SHELL_LOGIN: '1' },
      injected: true,
    });
    expect(injectShellIntegration({ shellType: 'bash', args: [], env, scripts, platform: 'linux' }).env).toEqual(env);
  });

  it('zsh: ZDOTDIR with the original kept in USER_ZDOTDIR', () => {
    const r = injectShellIntegration({ shellType: 'zsh', args: ['-l'], env, scripts, platform: 'darwin' });
    expect(r.args).toEqual(['-l']);
    expect(r.env).toMatchObject({ ZDOTDIR: '/data/si/zsh', USER_ZDOTDIR: '/home/me' });
    const custom = injectShellIntegration({
      shellType: 'zsh',
      args: [],
      env: { ...env, ZDOTDIR: '/home/me/.config/zsh' },
      scripts,
      platform: 'linux',
    });
    expect(custom.env['USER_ZDOTDIR']).toBe('/home/me/.config/zsh');
  });

  it('fish: our data dir first in XDG_DATA_DIRS, the original remembered', () => {
    const r = injectShellIntegration({ shellType: 'fish', args: [], env, scripts, platform: 'linux' });
    expect(r.env).toMatchObject({
      XDG_DATA_DIRS: '/data/si/fish:/usr/local/share:/usr/share',
      OXYTOCIN_XDG_DATA_DIRS: '',
    });
    const withDirs = injectShellIntegration({
      shellType: 'fish',
      args: [],
      env: { ...env, XDG_DATA_DIRS: '/opt/share' },
      scripts,
      platform: 'linux',
    });
    expect(withDirs.env).toMatchObject({
      XDG_DATA_DIRS: '/data/si/fish:/opt/share',
      OXYTOCIN_XDG_DATA_DIRS: '/opt/share',
    });
  });

  it('PowerShell: -NoExit -EncodedCommand with the UTF-16LE script (no execution policy, no quoting)', () => {
    const r = injectShellIntegration({ shellType: 'pwsh', args: ['-NoLogo'], env, scripts, platform: 'win32' });
    expect(r.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-EncodedCommand']);
    expect(Buffer.from(r.args[3]!, 'base64').toString('utf16le')).toBe('Write-Host hi');
    expect(
      injectShellIntegration({ shellType: 'powershell', args: [], env, scripts, platform: 'win32' }).injected,
    ).toBe(true);
  });

  it('leaves script runs and unsupported shells alone', () => {
    for (const [shellType, args] of [
      ['bash', ['-c', 'echo hi']],
      ['bash', ['script.sh']],
      ['bash', ['--rcfile', 'x']],
      ['zsh', ['-c', 'ls']],
      ['pwsh', ['-NoLogo', '-Command', 'ls']],
      ['pwsh', ['-File', 'x.ps1']],
      ['cmd', []],
      ['git-bash', ['--login', '-i']],
      ['wsl', ['-d', 'Ubuntu']],
      ['other', []],
    ] as const) {
      const r = injectShellIntegration({ shellType, args: [...args], env, scripts, platform: 'linux' });
      expect(r, `${shellType} ${args.join(' ')}`).toEqual({ args, env, injected: false });
    }
  });

  it('uses Windows separators on Windows', () => {
    const r = injectShellIntegration({
      shellType: 'bash',
      args: [],
      env,
      scripts: { ...scripts, dir: 'C:\\si' },
      platform: 'win32',
    });
    expect(r.args).toEqual(['--init-file', 'C:\\si\\bash.sh']);
  });
});

describe('installShellIntegration', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('copies every script into the layout the shells expect and returns the PowerShell text', async () => {
    dir = await mkdtemp(join(tmpdir(), 'oxy-si-install-'));
    const source = resolve(__dirname, '../../../../resources/shell-integration');
    const installed = await installShellIntegration(source, dir);
    expect(installed.pwsh).toContain('633;');
    for (const target of Object.keys(SHELL_INTEGRATION_FILES)) {
      expect((await stat(join(dir, target))).isFile(), target).toBe(true);
    }
    expect(await readFile(join(dir, 'zsh/.zshrc'), 'utf8')).toContain('oxytocin.zsh');
    // Second install: unchanged files are not rewritten.
    const before = (await stat(join(dir, 'bash.sh'))).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await installShellIntegration(source, dir);
    expect((await stat(join(dir, 'bash.sh'))).mtimeMs).toBe(before);
  });
});
