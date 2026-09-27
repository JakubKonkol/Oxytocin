import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HOOK_EVENTS } from './events';

export const MARKETPLACE_NAME = 'oxytocin';
export const PLUGIN_NAME = 'oxytocin-bridge';
export const INSTALL_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
export const HOOK_PATH = '/claude/hook';
/** Environment variables Claude Code may put into the hook headers (set in Oxytocin terminals only). */
export const TOKEN_VAR = 'OXYTOCIN_BRIDGE_TOKEN';
export const TERMINAL_VAR = 'OXYTOCIN_TERMINAL_ID';

/**
 * `hooks/hooks.json` of the Claude Code plugin: `http` hooks to the local endpoint. The URL cannot use variables
 * (Claude Code interpolates headers only), hence the fixed port; the token and the terminal id come from the
 * environment of Oxytocin terminals. Outside Oxytocin the headers are empty and the request fails harmlessly
 * (a non-blocking hook error).
 */
export function hooksConfig(port: number) {
  const hook = {
    type: 'http',
    url: `http://127.0.0.1:${port}${HOOK_PATH}`,
    timeout: 5,
    headers: { Authorization: `Bearer $${TOKEN_VAR}`, 'X-Oxytocin-Terminal': `$${TERMINAL_VAR}` },
    allowedEnvVars: [TOKEN_VAR, TERMINAL_VAR],
  };
  return {
    description: 'Reports Claude Code session states to Oxytocin (Claude Code Bridge).',
    hooks: Object.fromEntries(HOOK_EVENTS.map((event) => [event, [{ hooks: [hook] }]])),
  };
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Writes a local Claude Code marketplace with the bridge plugin into `dir`. `plugin.json` has no `version` on
 * purpose: Claude Code then loads the plugin in place from this folder, so rewritten hooks (a new port) apply at the
 * next session start; with a version it copies the plugin into its cache and pins it (checked with Claude Code
 * 2.1.283; `claude plugin validate` only warns about the missing version).
 */
export async function writeMarketplace(dir: string, port: number): Promise<string> {
  const pluginDir = join(dir, PLUGIN_NAME);
  await mkdir(join(dir, '.claude-plugin'), { recursive: true });
  await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true });
  await mkdir(join(pluginDir, 'hooks'), { recursive: true });
  const description = 'Reports Claude Code session states to Oxytocin through hooks.';
  await writeFile(
    join(dir, '.claude-plugin', 'marketplace.json'),
    json({
      name: MARKETPLACE_NAME,
      owner: { name: 'Oxytocin' },
      description: 'Created by Oxytocin (Claude Code Bridge).',
      plugins: [{ name: PLUGIN_NAME, source: `./${PLUGIN_NAME}`, description }],
    }),
  );
  await writeFile(
    join(pluginDir, '.claude-plugin', 'plugin.json'),
    json({
      name: PLUGIN_NAME,
      displayName: 'Oxytocin Bridge',
      description,
      author: { name: 'Oxytocin' },
      license: 'MIT',
    }),
  );
  await writeFile(join(pluginDir, 'hooks', 'hooks.json'), json(hooksConfig(port)));
  return dir;
}
