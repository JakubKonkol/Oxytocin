import { describe, expect, it } from 'vitest';
import { composeEnv } from './env-composer';

const base = {
  PATH: '/usr/bin',
  HOME: '/home/me',
  TERM_PROGRAM: 'vscode',
  VSCODE_PID: '1',
  ELECTRON_RUN_AS_NODE: '1',
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CONFIG_DIR: '/cfg',
  ANTHROPIC_API_KEY: 'sk',
  NODE_OPTIONS: '--max-old-space-size=4096',
};

const compose = (over: Partial<Parameters<typeof composeEnv>[0]> = {}) =>
  composeEnv({
    platform: 'linux',
    base,
    dev: false,
    appVersion: '0.1.0',
    projectId: 'p1',
    terminalId: 't1',
    layers: [],
    ...over,
  });

describe('composeEnv', () => {
  it('strips markers of other terminals, Electron and nested Claude Code but keeps user config', () => {
    const env = compose();
    expect(env['VSCODE_PID']).toBeUndefined();
    expect(env['ELECTRON_RUN_AS_NODE']).toBeUndefined();
    expect(env['CLAUDECODE']).toBeUndefined();
    expect(env['CLAUDE_CODE_ENTRYPOINT']).toBeUndefined();
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/cfg');
    expect(env['ANTHROPIC_API_KEY']).toBe('sk');
    expect(env['NODE_OPTIONS']).toBe('--max-old-space-size=4096');
  });

  it('strips NODE_OPTIONS in dev mode only', () => {
    expect(compose({ dev: true })['NODE_OPTIONS']).toBeUndefined();
  });

  it('sets the terminal identity', () => {
    const env = compose();
    expect(env).toMatchObject({
      TERM_PROGRAM: 'Oxytocin',
      TERM_PROGRAM_VERSION: '0.1.0',
      COLORTERM: 'truecolor',
      OXYTOCIN: '1',
      OXYTOCIN_PROJECT_ID: 'p1',
      OXYTOCIN_TERMINAL_ID: 't1',
      TERM: 'xterm-256color',
    });
    expect(compose({ platform: 'darwin' })['LANG']).toBe('en_US.UTF-8');
    expect(compose({ platform: 'win32' })['TERM']).toBeUndefined();
  });

  it('applies layers in order, null removes, and ${env:NAME} expands', () => {
    const env = compose({
      layers: [{ A: '1', PATH: '/opt/bin:${env:PATH}' }, { A: '2', HOME: null }, { B: '${env:A}-${env:MISSING}' }],
    });
    expect(env['A']).toBe('2');
    expect(env['PATH']).toBe('/opt/bin:/usr/bin');
    expect(env['HOME']).toBeUndefined();
    expect(env['B']).toBe('2-');
  });

  it('treats keys case-insensitively on Windows and keeps the original spelling', () => {
    const env = compose({
      platform: 'win32',
      base: { Path: 'C:\\Windows', ComSpec: 'cmd.exe' },
      layers: [{ PATH: 'C:\\bin;${env:path}' }, { comspec: null }],
    });
    expect(env['Path']).toBe('C:\\bin;C:\\Windows');
    expect(env['PATH']).toBeUndefined();
    expect(env['ComSpec']).toBeUndefined();
  });

  it('is case-sensitive on POSIX', () => {
    const env = compose({ base: { Path: 'a', PATH: 'b' } });
    expect(env['Path']).toBe('a');
    expect(env['PATH']).toBe('b');
  });
});
