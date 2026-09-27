import { describe, expect, it } from 'vitest';
import { cliPath, installInClaude, isInstalledInClaude, removeFromClaude, type RunCli } from './claude-cli';

function fakeCli(answers: Record<string, { ok: boolean; output: string }>) {
  const calls: string[] = [];
  const run: RunCli = (args) => {
    const key = args.join(' ');
    calls.push(key);
    const hit = Object.entries(answers).find(([prefix]) => key.startsWith(prefix));
    return Promise.resolve(hit ? hit[1] : { ok: true, output: '' });
  };
  return { run, calls };
}

describe('claude CLI', () => {
  it('adds the local marketplace, then installs the plugin for the user', async () => {
    const cli = fakeCli({});
    expect(await installInClaude(cli.run, '/data/claude-marketplace')).toMatchObject({ ok: true });
    expect(cli.calls).toEqual([
      'plugin marketplace add /data/claude-marketplace',
      'plugin install oxytocin-bridge@oxytocin --scope user',
    ]);
  });

  it('tolerates an existing marketplace or installation and reports other failures', async () => {
    const again = fakeCli({
      'plugin marketplace add': { ok: false, output: 'Marketplace already added' },
      'plugin install': { ok: false, output: 'Plugin is already installed' },
    });
    expect(await installInClaude(again.run, '/m')).toMatchObject({ ok: true });
    expect(again.calls.at(-1)).toBe('plugin update oxytocin-bridge@oxytocin');
    const broken = fakeCli({ 'plugin marketplace add': { ok: false, output: 'boom' } });
    expect(await installInClaude(broken.run, '/m')).toEqual({ ok: false, output: 'boom' });
    expect(broken.calls).toHaveLength(1);
  });

  it('removes the marketplace and reads the installed state', async () => {
    const cli = fakeCli({
      'plugin list': { ok: true, output: 'note\n[{"id":"oxytocin-bridge@oxytocin","enabled":true}]' },
    });
    await removeFromClaude(cli.run);
    expect(cli.calls).toEqual(['plugin marketplace remove oxytocin']);
    expect(await isInstalledInClaude(cli.run)).toBe(true);
    expect(await isInstalledInClaude(fakeCli({ 'plugin list': { ok: true, output: '[]' } }).run)).toBe(false);
    expect(await isInstalledInClaude(fakeCli({ 'plugin list': { ok: false, output: '' } }).run)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('adds the usual Claude Code folders to PATH', () => {
    expect(cliPath({ PATH: '/usr/bin' }, 'linux', '/home/me').split(':')).toEqual([
      '/usr/bin',
      '/home/me/.local/bin',
      '/home/me/.claude/local',
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ]);
  });
});
