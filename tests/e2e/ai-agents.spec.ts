import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { oxyTest, waitForTerminal } from './helpers/terminal';

const win32 = process.platform === 'win32';

/**
 * A fake `claude` on PATH that prints its version, or the API it was started against, and a home folder with a
 * signed-in Claude Code account.
 */
async function fakeAgents(): Promise<{ bin: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), 'oxy-e2e-ai-'));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  await mkdir(bin, { recursive: true });
  await mkdir(join(home, '.claude'), { recursive: true });
  if (win32) {
    await writeFile(
      join(bin, 'claude.cmd'),
      [
        '@echo off',
        'if "%1"=="--version" (echo 9.8.7 ^(Claude Code^)& exit /b 0)',
        'echo FAKE-CLAUDE base=[%ANTHROPIC_BASE_URL%] key=[%ANTHROPIC_AUTH_TOKEN%] model=[%ANTHROPIC_MODEL%] args=[%*]',
      ].join('\r\n'),
    );
  } else {
    const script = join(bin, 'claude');
    await writeFile(
      script,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "9.8.7 (Claude Code)"; exit 0; fi',
        'echo "FAKE-CLAUDE base=[$ANTHROPIC_BASE_URL] key=[$ANTHROPIC_AUTH_TOKEN] model=[$ANTHROPIC_MODEL] args=[$*]"',
      ].join('\n'),
    );
    await chmod(script, 0o755);
    // Login shells (the terminals) rebuild PATH from /etc/profile; the fake home puts the fake bin first again.
    const profile = `export PATH="${bin}:$PATH"\n`;
    await writeFile(join(home, '.profile'), profile);
    await writeFile(join(home, '.zprofile'), profile);
  }
  await writeFile(
    join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'naszekonto@mail.to', organizationName: 'Firma' } }),
  );
  await writeFile(
    join(home, '.claude', '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'never-shown', subscriptionType: 'max' } }),
  );
  return { bin, home };
}

async function openAiAgents(win: Page) {
  await win.getByTestId('open-settings').click();
  await win.locator('[data-testid="settings-section"][data-section="AI Agents"]').click();
  await expect(win.getByTestId('ai-agents-view')).toBeVisible();
}

async function newestTerminalText(win: Page, before: string[]): Promise<string> {
  const ids = await oxyTest(win).terminalIds();
  const id = ids.find((x) => !before.includes(x));
  return id ? oxyTest(win).text(id) : '';
}

test('AI agents: detects installed agents with their accounts and starts them from the + menu', async () => {
  const { bin, home } = await fakeAgents();
  const { app, win, userData } = await launchApp({
    env: {
      PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
      HOME: home,
      ...(win32 ? { USERPROFILE: home } : { TERM: 'xterm-256color' }),
      ANTHROPIC_API_KEY: '',
    },
  });
  try {
    await waitForTerminal(win);
    await openAiAgents(win);
    await win.getByTestId('ai-detect').click();
    const row = win.locator('[data-testid="ai-agent-row"][data-id="claude"]');
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText('naszekonto@mail.to');
    await expect(row).toContainText('Max');
    await expect(row).toContainText('9.8.7 (Claude Code)');
    await expect(win.getByTestId('ai-detected-at')).toContainText('just now');
    // Tokens are never read into Oxytocin's files.
    expect(await readFile(join(userData, 'ai-agents.json'), 'utf8')).not.toContain('never-shown');

    // Launch commands are configured in the same AI Agents settings and used by the + menu.
    await win.getByTestId('ai-command-claude').fill('claude --custom-test');
    await win.getByTestId('ai-commands-save').click();
    await expect
      .poll(
        async () =>
          (
            JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8').catch(() => '{}')) as Record<
              string,
              Record<string, string>
            >
          )['aiAgents.commands']?.['claude'],
      )
      .toBe('claude --custom-test');

    // The "+" menu has an AI agents section: "Claude Code (naszekonto@mail.to)".
    let before = await oxyTest(win).terminalIds();
    await win.getByTestId('group-add').first().click();
    const item = win.getByTestId('add-ai-ai:claude');
    await expect(item).toContainText('Claude Code');
    await expect(item).toContainText('(naszekonto@mail.to)');
    await item.click();
    await expect.poll(() => newestTerminalText(win, before), { timeout: 20_000 }).toContain('FAKE-CLAUDE base=[]');
    await expect.poll(() => newestTerminalText(win, before)).toContain('args=[--custom-test]');

    // A profile runs Claude Code against another API with its key; the key never reaches the renderer's state.
    await openAiAgents(win);
    await win.getByTestId('ai-profile-add').click();
    await win.getByTestId('ai-profile-add-glm').click();
    const form = win.getByTestId('ai-profile-form');
    await expect(form.getByTestId('ai-profile-url')).toHaveValue('https://api.z.ai/api/anthropic');
    await form.getByTestId('ai-profile-name').fill('GLM work');
    await form.getByTestId('ai-profile-url').fill('http://127.0.0.1:9/anthropic');
    await form.getByTestId('ai-profile-model').fill('glm-test');
    await form.getByTestId('ai-profile-key').fill('zai-test-key');
    await win.getByTestId('ai-profiles-save').click();
    await expect(win.getByTestId('ai-profile-key-state')).toHaveAttribute('data-state', 'set');
    expect(await readFile(join(userData, 'ai-agents.json'), 'utf8')).not.toContain('zai-test-key');

    before = await oxyTest(win).terminalIds();
    await win.getByTestId('group-add').first().click();
    const profileItem = win.locator('[data-testid^="add-ai-ai:profile:"]');
    await expect(profileItem).toContainText('GLM work');
    await expect(profileItem).toContainText('GLM (Z.ai) · glm-test');
    await profileItem.click();
    await expect
      .poll(() => newestTerminalText(win, before), { timeout: 20_000 })
      .toContain('FAKE-CLAUDE base=[http://127.0.0.1:9/anthropic] key=[zai-test-key] model=[glm-test]');

    // Hidden from the + menu.
    await openAiAgents(win);
    await win.getByTestId('ai-agent-menu-claude').click();
    await expect(win.getByTestId('ai-agent-menu-claude')).not.toBeChecked();
    await expect.poll(async () => readFile(join(userData, 'ai-agents.json'), 'utf8')).toContain('"ai:claude"');
    await win.getByTestId('group-add').first().click();
    await expect(win.getByTestId('add-ai-manage')).toBeVisible();
    await expect(win.getByTestId('add-ai-ai:claude')).toHaveCount(0);
    await win.keyboard.press('Escape');
  } finally {
    await app.close();
  }
});

/** A fake `claude` that prints the account folder it was started on and a skill read through that folder. */
async function fakeAccountClaude(): Promise<{ bin: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), 'oxy-e2e-acc-'));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  await mkdir(bin, { recursive: true });
  await mkdir(join(home, '.claude', 'skills', 'review'), { recursive: true });
  await writeFile(join(home, '.claude', 'skills', 'review', 'SKILL.md'), 'SHARED-SKILL\n');
  if (win32) {
    await writeFile(
      join(bin, 'claude.cmd'),
      [
        '@echo off',
        'if "%1"=="--version" (echo 9.8.7 ^(Claude Code^)& exit /b 0)',
        'echo FAKE-CLAUDE dir=[%CLAUDE_CONFIG_DIR%] key=[%ANTHROPIC_API_KEY%]',
        'if defined CLAUDE_CONFIG_DIR type "%CLAUDE_CONFIG_DIR%\\skills\\review\\SKILL.md"',
      ].join('\r\n'),
    );
  } else {
    const script = join(bin, 'claude');
    await writeFile(
      script,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "9.8.7 (Claude Code)"; exit 0; fi',
        'echo "FAKE-CLAUDE dir=[$CLAUDE_CONFIG_DIR] key=[$ANTHROPIC_API_KEY]"',
        'if [ -n "$CLAUDE_CONFIG_DIR" ]; then cat "$CLAUDE_CONFIG_DIR/skills/review/SKILL.md"; fi',
      ].join('\n'),
    );
    await chmod(script, 0o755);
    const profile = `export PATH="${bin}:$PATH"\n`;
    await writeFile(join(home, '.profile'), profile);
    await writeFile(join(home, '.zprofile'), profile);
  }
  await writeFile(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'prywatne@mail.to' } }));
  return { bin, home };
}

test('AI agents: adds a second Claude Code account that shares the main setup and runs next to it', async () => {
  const { bin, home } = await fakeAccountClaude();
  const { app, win } = await launchApp({
    env: {
      PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
      HOME: home,
      ...(win32 ? { USERPROFILE: home } : { TERM: 'xterm-256color' }),
      ANTHROPIC_API_KEY: 'sk-from-the-environment',
      CLAUDE_CONFIG_DIR: '',
    },
  });
  const accountHome = join(home, '.oxytocin', 'accounts', 'claude', 'work');
  try {
    await waitForTerminal(win);
    await openAiAgents(win);
    await win.getByTestId('ai-detect').click();
    await expect(win.locator('[data-testid="ai-agent-row"][data-id="claude"]')).toBeVisible({ timeout: 30_000 });
    const claude = win.locator('[data-testid="ai-accounts-agent"][data-agent="claude"]');
    await expect(claude.getByTestId('ai-account-main')).toContainText('prywatne@mail.to');

    // Add account → its first terminal starts on the account's folder (to sign in), without the user's API key.
    let before = await oxyTest(win).terminalIds();
    await claude.getByTestId('ai-account-add-claude').click();
    await win.getByTestId('ai-account-name').fill('Work');
    await win.getByTestId('ai-account-create').click();
    await expect
      .poll(() => newestTerminalText(win, before), { timeout: 20_000 })
      .toContain(`FAKE-CLAUDE dir=[${accountHome}] key=[]`);
    // The main account's skills are there through the account's folder.
    await expect.poll(() => newestTerminalText(win, before), { timeout: 10_000 }).toContain('SHARED-SKILL');

    await openAiAgents(win);
    const row = claude.getByTestId('ai-account-row');
    await expect(row).toContainText('Work');
    await expect(row.getByTestId('ai-account-login')).toContainText('Not signed in');

    // Signed in (the CLI writes .claude.json in the account's folder): the e-mail shows after the next check.
    await writeFile(
      join(accountHome, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'praca@firma.pl' } }),
    );
    await win.getByTestId('ai-detect').click();
    await expect(row.getByTestId('ai-account-login')).toContainText('praca@firma.pl', { timeout: 30_000 });

    // The + menu starts the account and the main account side by side.
    before = await oxyTest(win).terminalIds();
    await win.getByTestId('group-add').first().click();
    const item = win.locator('[data-testid^="add-ai-ai:account:"]');
    await expect(item).toContainText('Claude Code · Work');
    await expect(item).toContainText('(praca@firma.pl)');
    await item.click();
    await expect
      .poll(() => newestTerminalText(win, before), { timeout: 20_000 })
      .toContain(`FAKE-CLAUDE dir=[${accountHome}]`);
    before = await oxyTest(win).terminalIds();
    await win.getByTestId('group-add').first().click();
    await win.getByTestId('add-ai-ai:claude').click();
    await expect
      .poll(() => newestTerminalText(win, before), { timeout: 20_000 })
      .toContain('FAKE-CLAUDE dir=[] key=[sk-from-the-environment]');

    // Removing the account deletes its folder only.
    await openAiAgents(win);
    await row.getByTestId('ai-account-remove').click();
    await win.getByTestId('confirm-dialog').getByRole('button', { name: 'Remove account' }).click();
    await expect(claude.getByTestId('ai-account-row')).toHaveCount(0);
    await expect(stat(accountHome)).rejects.toThrow();
    expect(await readFile(join(home, '.claude', 'skills', 'review', 'SKILL.md'), 'utf8')).toBe('SHARED-SKILL\n');
  } finally {
    await app.close();
  }
});
