/**
 * Refreshes the Usage Monitor pricing snapshot from LiteLLM (docs/plan/08-usage-monitor.md §10.1).
 * Usage: `npm run pricing:update [-- --file <local model_prices_and_context_window.json>]`
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LITELLM_URL, transformLitellm } from '../plugins/usage-monitor/src/host/pricing/litellm';

const OUT = resolve(__dirname, '../plugins/usage-monitor/src/host/pricing/snapshot.json');

async function main(): Promise<void> {
  const i = process.argv.indexOf('--file');
  let data: Record<string, unknown>;
  if (i >= 0) data = JSON.parse(await readFile(process.argv[i + 1]!, 'utf8')) as Record<string, unknown>;
  else {
    const res = await fetch(LITELLM_URL);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    data = (await res.json()) as Record<string, unknown>;
  }
  const table = transformLitellm(data);
  await writeFile(OUT, `${JSON.stringify(table, null, 1)}\n`);
  console.log(`${OUT}: ${Object.keys(table.models).length} models, version ${table.version}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
