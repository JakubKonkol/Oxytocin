import { execFileSync } from 'node:child_process';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Frame, type Page, test } from '@playwright/test';
import { launchApp, repoRoot } from './helpers/launch';
import { oxyTest, run, waitForTerminal } from './helpers/terminal';

const fakeClaude = join(repoRoot, 'tests/fixtures/agents/node_modules/@anthropic-ai/claude-code/cli.js');
const fakeCodex = join(repoRoot, 'tests/fixtures/agents/node_modules/@openai/codex/bin/codex.js');

async function relayFrame(win: Page): Promise<Frame> {
  let frame: Frame | undefined;
  await expect
    .poll(
      () =>
        (frame = win
          .frames()
          .find((f) => f.url().startsWith('oxy-plugin://oxytocin.relay/dist/views/relay.html') && !f.isDetached())),
      { timeout: 15_000 },
    )
    .toBeTruthy();
  return frame!;
}

const agentState = async (win: Page, terminalId: string) =>
  ((await win.evaluate(() => window.oxy.invoke('agents:list'))) as { terminalId: string; state: string }[]).find(
    (a) => a.terminalId === terminalId,
  )?.state;

async function gitRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'oxy-e2e-relay-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  await writeFile(join(repo, 'TODO.md'), '# Steps\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return repo;
}

test('Relay: Codex takes over when Claude ends a turn near its limit; a reviewer gets each change', async () => {
  const claudeDir = await mkdtemp(join(tmpdir(), 'oxy-e2e-claude-'));
  const repo = await gitRepo();
  const { app, win } = await launchApp({ project: repo, env: { CLAUDE_CONFIG_DIR: claudeDir } });
  try {
    // Claude Code in the first terminal, Codex CLI in a second one.
    const claude = await waitForTerminal(win);
    await win.locator(`[data-terminal-id="${claude}"] .xterm`).click();
    await run(win, `node "${fakeClaude}"`);
    await expect.poll(() => oxyTest(win).text(claude)).toContain('fake-claude>');
    const before = await oxyTest(win).terminalIds();
    // Side by side: both stay visible.
    await win.getByTestId('group-actions').first().getByRole('button', { name: 'Split right' }).click();
    let codex = '';
    await expect
      .poll(async () => (codex = (await oxyTest(win).terminalIds()).find((id) => !before.includes(id)) ?? ''))
      .not.toBe('');
    await expect.poll(() => oxyTest(win).text(codex), { timeout: 15_000 }).not.toBe('');
    await win.locator(`[data-terminal-id="${codex}"] .xterm`).click();
    await run(win, `node "${fakeCodex}" --status`);
    await expect.poll(() => oxyTest(win).text(codex)).toContain('fake-codex>');
    await expect
      .poll(async () => ((await win.evaluate(() => window.oxy.invoke('agents:list'))) as unknown[]).length, {
        timeout: 15_000,
      })
      .toBe(2);

    // Claude's 5-hour limit at 95%, as its status line reports it to the Usage Monitor.
    await win.evaluate(() => window.oxy.invoke('settings:update', { 'usage.claudeLimits.statusLine': true }));
    const dataDir = join(claudeDir, 'oxytocin-statusline');
    await expect
      .poll(() =>
        stat(join(dataDir, 'statusline.sh')).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    await writeFile(
      join(dataDir, 'usage.json'),
      JSON.stringify({
        rate_limits: { five_hour: { used_percentage: 95, resets_at: Math.floor(Date.now() / 1000) + 7200 } },
      }),
    );

    // Command palette → "Relay: Show Relay Panel": next to the terminals.
    await win.evaluate(() => window.oxy.invoke('plugins:executeCommand', { id: 'relay.show' }));
    const relay = await relayFrame(win);
    const rows = relay.getByTestId('relay-agent');
    await expect(rows).toHaveCount(2, { timeout: 15_000 });
    const claudeRow = relay.locator(`[data-testid="relay-agent"][data-terminal="${claude}"]`);
    const codexRow = relay.locator(`[data-testid="relay-agent"][data-terminal="${codex}"]`);
    await expect(claudeRow).toContainText('Claude (main)');
    await expect(claudeRow).toContainText('95% of 5-hour', { timeout: 15_000 });
    await expect(codexRow).toContainText('Codex (main)');
    await relay.getByTestId('relay-enabled').check();
    await relay.getByTestId('relay-prompt').fill('Continue after {from}: status in TODO.md');
    // Saved when the field loses the focus.
    await relay.getByTestId('relay-prompt').press('Tab');

    // Claude works, then stops: its turn is over with the limit nearly used → Codex gets the one prompt.
    await win.locator(`[data-terminal-id="${claude}"] .xterm`).click();
    await run(win, 'work');
    await expect.poll(() => agentState(win, claude), { timeout: 10_000 }).toBe('working');
    await run(win, 'done');
    await expect
      .poll(() => oxyTest(win).text(codex), { timeout: 20_000 })
      .toContain('PROMPT: Continue after Claude (main): status in TODO.md');
    await expect(relay.getByTestId('relay-log')).toContainText('Handed over from Claude (main) to Codex (main).');

    // Review mode: Codex reviews what Claude changes.
    await relay.locator('[data-testid="relay-mode"] [data-value="review"]').click();
    await codexRow.getByTestId('relay-reviewer').check();
    await expect(codexRow).toContainText('reviewer');
    await relay.getByTestId('relay-prompt').fill('Review {from}: {files}');
    await relay.getByTestId('relay-prompt').press('Tab');
    await win.locator(`[data-terminal-id="${claude}"] .xterm`).click();
    await run(win, 'work');
    await expect.poll(() => agentState(win, claude), { timeout: 10_000 }).toBe('working');
    await writeFile(join(repo, 'feature.ts'), 'export const feature = 1;\n');
    await win.waitForTimeout(1000);
    await run(win, 'done');
    await expect
      .poll(() => oxyTest(win).text(codex), { timeout: 20_000 })
      .toContain('PROMPT: Review Claude (main): feature.ts');
    await expect(relay.getByTestId('relay-log')).toContainText(
      'Asked Codex (main) to review the changes of Claude (main).',
    );
  } finally {
    await app.close();
  }
});
