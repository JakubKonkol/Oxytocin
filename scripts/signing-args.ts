/**
 * Prints the electron-builder arguments for a release build and, in GitHub Actions, exports the signing
 * environment (`$GITHUB_ENV`) and `signed`/`notarized` outputs. Usage: tsx scripts/signing-args.ts <win|mac|linux>
 */
import { appendFileSync } from 'node:fs';
import { signingPlan, type SigningPlatform } from './lib/signing';

const platform = process.argv[2] as SigningPlatform;
if (!['win', 'mac', 'linux'].includes(platform)) {
  console.error('Usage: tsx scripts/signing-args.ts <win|mac|linux>');
  process.exit(2);
}
const plan = signingPlan(platform, process.env);
console.error(plan.summary);
const envFile = process.env['GITHUB_ENV'];
const outFile = process.env['GITHUB_OUTPUT'];
if (envFile) {
  for (const [k, v] of Object.entries(plan.env)) appendFileSync(envFile, `${k}=${v}\n`);
}
if (outFile) {
  appendFileSync(outFile, `args=${plan.args.join(' ')}\nsigned=${plan.signed}\nnotarized=${plan.notarized}\n`);
}
console.log(plan.args.join(' '));
