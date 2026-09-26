import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './launch';

export const fixturePlugin = (name: string) => join(repoRoot, 'tests/fixtures/plugins', name);

/** A userData folder whose settings load the given fixture plugins in developer mode. */
export async function userDataWithPlugins(names: string[], extra: Record<string, unknown> = {}): Promise<string> {
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({ 'plugins.developerMode': true, 'plugins.devPaths': names.map(fixturePlugin), ...extra }),
  );
  return userData;
}
