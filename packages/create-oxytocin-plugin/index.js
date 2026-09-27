#!/usr/bin/env node
// npm create oxytocin-plugin [folder] [--id publisher.name] [--name "Display Name"] [--publisher name]
//                            [--template vanilla|react] [--yes]
import { execFileSync } from 'node:child_process';
import { basename, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { scaffold, slug, TEMPLATES, titleCase, validateId } from './lib/scaffold.js';

const HELP = `Usage: npm create oxytocin-plugin [folder] -- [options]

Options:
  --id <publisher.name>    Plugin id (lowercase, dot-separated)
  --name <text>            Display name
  --publisher <name>       Publisher shown in the consent dialog
  --template <vanilla|react>
  -y, --yes                Use the defaults for everything not given
  -h, --help`;

function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '-y' || a === '--yes') out.yes = true;
    else if (a.startsWith('--')) {
      const [key, inline] = a.slice(2).split('=', 2);
      out[key] = inline ?? argv[++i];
    } else out.positional.push(a);
  }
  return out;
}

function gitUser() {
  try {
    return execFileSync('git', ['config', 'user.name'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  const interactive = !args.yes && process.stdin.isTTY;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (question, fallback, check) => {
    if (!rl) return fallback;
    for (;;) {
      const answer = (await rl.question(`${question} (${fallback}): `)).trim() || fallback;
      const problem = check?.(answer);
      if (!problem) return answer;
      console.log(`  ${problem}`);
    }
  };
  try {
    const folder = args.positional[0] ?? (await ask('Folder', 'my-oxytocin-plugin'));
    const base = basename(resolve(folder));
    const publisher = args.publisher ?? (await ask('Publisher', slug(gitUser() || 'me')));
    const id = args.id ?? (await ask('Plugin id', `${slug(publisher).replace(/-/g, '')}.${slug(base)}`, validateId));
    const name = args.name ?? (await ask('Display name', titleCase(base)));
    const template =
      args.template ??
      (await ask(`Template (${TEMPLATES.join('/')})`, 'vanilla', (t) =>
        TEMPLATES.includes(t) ? null : `Choose one of: ${TEMPLATES.join(', ')}`,
      ));
    const targetDir = resolve(folder);
    await scaffold({ targetDir, id, name, publisher, template });
    const cd = relative(process.cwd(), targetDir) || '.';
    console.log(`
Created ${name} (${id}) in ${cd}

Next steps:
  cd ${cd}
  npm install
  npm run build

Then in Oxytocin: Plugins → Developer mode → "Load plugin from folder…" and pick ${cd}.
"npm run dev" rebuilds on every change and Oxytocin reloads the plugin.
"npm run package" creates a .zip for "Install from .zip…".`);
  } finally {
    rl?.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
