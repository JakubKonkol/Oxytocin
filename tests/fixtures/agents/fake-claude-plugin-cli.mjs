#!/usr/bin/env node
// Fake `claude plugin …` CLI for the Claude Code Bridge E2E test: appends its arguments to $FAKE_CLAUDE_CLI_LOG
// (one JSON array per line) and answers `plugin list --json` from what was installed or removed.
import fs from 'node:fs';

const log = process.env.FAKE_CLAUDE_CLI_LOG;
const args = process.argv.slice(2);
fs.appendFileSync(log, `${JSON.stringify(args)}\n`);
const history = fs
  .readFileSync(log, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l).join(' '));
if (args.join(' ') === 'plugin list --json') {
  const installed = history.reduce((state, cmd) => {
    if (cmd.startsWith('plugin install oxytocin-bridge@oxytocin')) return true;
    if (cmd.startsWith('plugin marketplace remove oxytocin')) return false;
    return state;
  }, false);
  process.stdout.write(JSON.stringify(installed ? [{ id: 'oxytocin-bridge@oxytocin', enabled: true }] : []));
} else if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
  if (!fs.existsSync(`${args[3]}/.claude-plugin/marketplace.json`)) {
    process.stderr.write('Marketplace file not found');
    process.exit(1);
  }
  process.stdout.write('✔ Successfully added marketplace: oxytocin (declared in user settings)');
} else if (args[1] === 'install') {
  process.stdout.write(`✔ Successfully installed plugin: ${args[2]} (scope: user)`);
} else {
  process.stdout.write('✔ Done');
}
