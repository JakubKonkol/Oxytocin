import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hooksConfig, writeMarketplace } from './claude-plugin';

describe('Claude Code plugin files', () => {
  it('uses http hooks with the token and terminal id from the environment', () => {
    const config = hooksConfig(47285);
    expect(Object.keys(config.hooks)).toEqual([
      'UserPromptSubmit',
      'PostToolUse',
      'PermissionRequest',
      'Notification',
      'Stop',
      'SessionEnd',
    ]);
    expect(config.hooks['Stop']).toEqual([
      {
        hooks: [
          {
            type: 'http',
            url: 'http://127.0.0.1:47285/claude/hook',
            timeout: 5,
            headers: { Authorization: 'Bearer $OXYTOCIN_BRIDGE_TOKEN', 'X-Oxytocin-Terminal': '$OXYTOCIN_TERMINAL_ID' },
            allowedEnvVars: ['OXYTOCIN_BRIDGE_TOKEN', 'OXYTOCIN_TERMINAL_ID'],
          },
        ],
      },
    ]);
  });

  it('writes a local marketplace with the plugin', async () => {
    const dir = await writeMarketplace(join(await mkdtemp(join(tmpdir(), 'oxy-bridge-')), 'm'), 50001);
    const read = async (path: string) => JSON.parse(await readFile(join(dir, path), 'utf8')) as Record<string, unknown>;
    expect(await read('.claude-plugin/marketplace.json')).toMatchObject({
      name: 'oxytocin',
      owner: { name: 'Oxytocin' },
      plugins: [{ name: 'oxytocin-bridge', source: './oxytocin-bridge' }],
    });
    const manifest = await read('oxytocin-bridge/.claude-plugin/plugin.json');
    expect(manifest).toMatchObject({ name: 'oxytocin-bridge', author: { name: 'Oxytocin' } });
    // No version: `claude plugin update` must be able to refresh Claude Code's cached copy.
    expect(manifest).not.toHaveProperty('version');
    expect(JSON.stringify(await read('oxytocin-bridge/hooks/hooks.json'))).toContain(
      'http://127.0.0.1:50001/claude/hook',
    );
  });
});
