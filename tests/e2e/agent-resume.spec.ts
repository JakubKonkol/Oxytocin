import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { activeProjectId, nodeCmd, oxyTest, waitForTerminal } from './helpers/terminal';

const count = (text: string, needle: string) => text.split(needle).length - 1;

async function agentPanelText(win: Page): Promise<{ terminalId: string; text: string }> {
  const t = oxyTest(win);
  const ws = (await t.workspace())!;
  for (const p of ws.panels) {
    const text = await t.text(p.terminalId!);
    if (text.includes('AGENT-STARTED')) return { terminalId: p.terminalId!, text };
  }
  return { terminalId: '', text: '' };
}

test('restored agent terminals never start the agent by themselves and offer "Resume session"', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({
      'terminal.profiles': [
        { id: 'agent:fake', name: 'Fake Agent', kind: 'agent', command: nodeCmd("console.log('AGENT-' + 'STARTED')") },
      ],
    }),
  );
  const project = await mkdtemp(join(tmpdir(), 'oxy-e2e-project-'));
  let projectId: string;

  const first = await launchApp({ userData, project });
  try {
    await waitForTerminal(first.win);
    projectId = await activeProjectId(first.win);
    await first.win.keyboard.press('Control+Shift+KeyN');
    await first.win.getByTestId('profile-picker').getByText('Fake Agent').click();
    // A fresh agent terminal does run its command.
    await expect.poll(async () => (await agentPanelText(first.win)).text).toContain('AGENT-STARTED');
    await first.win.waitForTimeout(1500);
  } finally {
    await first.app.close();
  }

  // The agent's session id as recorded while it ran (Claude registry / usage monitor).
  const file = join(userData, 'workspaces', `${projectId}.json`);
  const state = JSON.parse(await readFile(file, 'utf8')) as {
    panels: Record<string, { kind: string; profileId?: string; agent?: unknown }>;
  };
  const panel = Object.values(state.panels).find((p) => p.profileId === 'agent:fake')!;
  expect(panel).toBeTruthy();
  panel.agent = { agentId: 'claude-code', sessionId: 'sess-0123' };
  await writeFile(file, JSON.stringify(state));

  const second = await launchApp({ userData });
  try {
    await expect(second.win.getByTestId('app-ready')).toBeVisible();
    const bar = second.win.getByTestId('terminal-resume-bar');
    await expect(bar).toBeVisible({ timeout: 15_000 });
    await expect(second.win.getByTestId('terminal-resume-command')).toHaveText('(claude --resume sess-0123)');
    // Only the restored scrollback shows the old output: the agent command was not typed again.
    await second.win.waitForTimeout(1500);
    const restored = await agentPanelText(second.win);
    expect(count(restored.text, 'AGENT-STARTED')).toBe(1);

    await second.win.getByTestId('terminal-resume').click();
    await expect(bar).toHaveCount(0);
    // A long prompt (PowerShell on CI) can wrap the command onto the next buffer line.
    await expect
      .poll(async () => (await oxyTest(second.win).text(restored.terminalId)).replace(/\r?\n/g, ''))
      .toContain('claude --resume sess-0123');
    await second.win.waitForTimeout(1200);
  } finally {
    await second.app.close();
  }

  // Once handled, the offer does not come back.
  const third = await launchApp({ userData });
  try {
    await expect(third.win.getByTestId('app-ready')).toBeVisible();
    await expect.poll(async () => (await oxyTest(third.win).workspace())?.panels.length).toBe(2);
    await third.win.waitForTimeout(1500);
    await expect(third.win.getByTestId('terminal-resume-bar')).toHaveCount(0);
  } finally {
    await third.app.close();
  }
});
