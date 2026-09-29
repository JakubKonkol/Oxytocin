/**
 * Checks that the update manifests of a packaged build point at files that exist (release workflow):
 * tsx scripts/verify-update-manifests.ts <folder with the packages, e.g. release>
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isUpdateManifest, updateManifestProblems } from './lib/update-manifests';

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: tsx scripts/verify-update-manifests.ts <folder>');
  process.exit(2);
}
const files = new Map<string, string | null>();
for (const name of readdirSync(dir)) {
  const full = join(dir, name);
  if (!statSync(full).isFile()) continue;
  files.set(name, isUpdateManifest(name) ? readFileSync(full, 'utf8') : null);
}
const problems = updateManifestProblems(files);
for (const problem of problems) console.error(`FAIL ${problem}`);
if (problems.length > 0) process.exit(1);
console.log(`ok   ${[...files.keys()].filter(isUpdateManifest).join(', ')} point at existing packages`);
