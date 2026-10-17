import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Frame, type Page, test } from '@playwright/test';
import type { AgentSnapshot, AgentLaunchResult } from '@oxytocin/plugin-api';
import { launchApp, repoRoot } from './helpers/launch';
import { oxyTest, waitForTerminal } from './helpers/terminal';

async function taskFrame(win: Page): Promise<Frame> {
  await win.evaluate(() => window.oxy.invoke('plugins:executeCommand', { id: 'task.show' }));
  await expect(win.getByTestId('secondary-sidebar').getByTestId('sidebar-tool-task.panel')).toBeVisible();
  let frame: Frame | undefined;
  await expect
    .poll(
      () =>
        (frame = win
          .frames()
          .find((f) => f.url().startsWith('oxy-plugin://oxytocin.task/dist/views/task.html') && !f.isDetached())),
    )
    .toBeTruthy();
  return frame!;
}

test('Task captures a native plan, reuses a planner, hands the approved document to an implementer and starts review manually', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), 'oxy-e2e-task-'));
  const repo = join(root, 'repo');
  const userData = join(root, 'data');
  const claudeHome = join(root, 'claude');
  await mkdir(repo);
  await mkdir(userData);
  await mkdir(claudeHome);
  const git = (...args: string[]) =>
    execFileSync('git', ['--no-optional-locks', ...args], { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await writeFile(join(repo, 'test.txt'), 'before\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  await writeFile(join(repo, 'test.txt'), 'after\n');
  const fakeClaude = join(repoRoot, 'tests/fixtures/agents/node_modules/@anthropic-ai/claude-code/cli.js');
  const fakeCodex = join(repoRoot, 'tests/fixtures/agents/node_modules/@openai/codex/bin/codex.js');
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({
      'usage.pricing.autoUpdate': false,
      'aiAgents.commands': { claude: `node "${fakeClaude}"`, codex: `node "${fakeCodex}" --status` },
    }),
  );
  await writeFile(
    join(userData, 'ai-agents.json'),
    JSON.stringify({
      version: 1,
      detectedAt: Date.now(),
      agents: [
        { id: 'claude', name: 'Claude Code', command: 'claude', category: 'agent', accounts: [] },
        { id: 'codex', name: 'Codex CLI', command: 'codex', category: 'agent', accounts: [] },
      ],
    }),
  );
  const { app, win } = await launchApp({ project: repo, userData, env: { CLAUDE_CONFIG_DIR: claudeHome } });
  try {
    await waitForTerminal(win);
    const projectId = await win.evaluate(
      async () => ((await window.oxy.invoke('projects:list')) as { id: string }[])[0]!.id,
    );
    const planner = (await win.evaluate(
      (projectId) => window.oxy.invoke('aiAgents:launch', { projectId, launchId: 'ai:claude' }),
      projectId,
    )) as AgentLaunchResult;
    await expect
      .poll(
        async () =>
          ((await win.evaluate(() => window.oxy.invoke('agents:list'))) as AgentSnapshot[]).find(
            (a) => a.terminalId === planner.terminalId,
          )?.state,
        { timeout: 20_000 },
      )
      .toBe('idle');
    const before = (await oxyTest(win).terminalIds()).length;
    const plannerGroup = (await oxyTest(win).workspace())?.panels.find(
      (p) => p.terminalId === planner.terminalId,
    )?.group;
    expect((await oxyTest(win).workspace())?.groups).toBe(2);
    const frame = await taskFrame(win);
    await frame.getByTestId('task-description').fill('Improve the search field');
    await frame.getByTestId('task-planner').selectOption('ai:claude');
    await frame.getByTestId('task-implementer').selectOption('ai:codex');
    await frame.getByTestId('task-reviewer').selectOption('ai:claude');
    await frame.getByTestId('task-start').click();
    await expect.poll(() => oxyTest(win).text(planner.terminalId)).toContain('Improve the search field');
    await expect.poll(() => oxyTest(win).activeTerminalId()).toBe(planner.terminalId);
    expect((await oxyTest(win).workspace())?.panels.some((p) => p.terminalId === planner.terminalId)).toBe(true);
    await expect(win.locator(`[data-terminal-id="${planner.terminalId}"] .xterm-helper-textarea`)).toBeFocused();
    await taskFrame(win);
    await expect(frame.getByTestId('task-plan')).toBeVisible();
    expect((await oxyTest(win).terminalIds()).length).toBe(before);
    const agent = ((await win.evaluate(() => window.oxy.invoke('agents:list'))) as AgentSnapshot[]).find(
      (a) => a.terminalId === planner.terminalId,
    )!;
    await mkdir(join(claudeHome, 'plans'), { recursive: true });
    await mkdir(join(claudeHome, 'projects', '-fixture'), { recursive: true });
    await writeFile(join(claudeHome, 'plans', 'search-plan.md'), '# Search plan\nAdd a keyboard shortcut and test it.');
    await writeFile(
      join(claudeHome, 'projects', '-fixture', `${agent.sessionId}.jsonl`),
      JSON.stringify({
        slug: 'search-plan',
        message: { content: [{ type: 'text', text: 'PRIVATE PLANNER CONVERSATION' }] },
      }),
    );
    await expect(frame.getByTestId('task-plan')).toHaveValue(/Add a keyboard shortcut/, { timeout: 15_000 });
    await win.screenshot({ path: test.info().outputPath('task-plan.png') });
    await frame.getByTestId('task-approve').click();
    let codex = '';
    await expect
      .poll(
        async () =>
          (codex =
            ((await win.evaluate(() => window.oxy.invoke('agents:list'))) as AgentSnapshot[]).find(
              (a) => a.agentId === 'codex',
            )?.terminalId ?? ''),
        { timeout: 20_000 },
      )
      .not.toBe('');
    await expect.poll(() => oxyTest(win).text(codex)).toContain('Add a keyboard shortcut');
    await expect.poll(() => oxyTest(win).activeTerminalId()).toBe(codex);
    expect((await oxyTest(win).workspace())?.panels.some((p) => p.terminalId === codex)).toBe(true);
    expect((await oxyTest(win).workspace())?.panels.find((p) => p.terminalId === codex)?.group).not.toBe(plannerGroup);
    expect(await oxyTest(win).text(codex)).not.toContain('PRIVATE PLANNER CONVERSATION');
    await taskFrame(win);
    await expect(frame.getByTestId('task-plan')).toHaveAttribute('readonly', '');
    await frame.getByTestId('task-review').click();
    await expect
      .poll(
        async () =>
          ((await win.evaluate(() => window.oxy.invoke('agents:list'))) as AgentSnapshot[]).filter(
            (a) => a.agentId === 'claude-code',
          ).length,
        { timeout: 20_000 },
      )
      .toBe(2);
    await taskFrame(win);
    await expect(frame.getByTestId('task-done')).toBeEnabled();
    await frame.getByTestId('task-done').click();
    await expect(frame.getByText('COMPLETED', { exact: true })).toBeVisible();

    // Reopening reveals the singleton. Moves retain the saved task.
    await taskFrame(win);
    await expect(win.getByTestId('sidebar-tool-task.panel')).toHaveCount(1);
    const tools = async () =>
      (await win.evaluate(() => window.oxy.invoke('ui:getState'))) as {
        primaryTools: { id: string; panelType?: string }[];
        secondaryTools: { id: string; panelType?: string }[];
      };
    let toolId = '';
    await expect
      .poll(async () => (toolId = (await tools()).secondaryTools.find((t) => t.panelType === 'task.panel')?.id ?? ''))
      .not.toBe('');
    await win.getByTestId(`section-header-${toolId}`).hover();
    await win.getByTestId(`move-tool-side-${toolId}`).click();
    await expect(win.getByTestId('sidebar').getByTestId('sidebar-tool-task.panel')).toBeVisible();
    const currentFrame = async () => {
      let next: Frame | undefined;
      await expect
        .poll(
          () =>
            (next = win
              .frames()
              .find((f) => f.url().startsWith('oxy-plugin://oxytocin.task/dist/views/task.html') && !f.isDetached())),
        )
        .toBeTruthy();
      return next!;
    };
    let moved = await currentFrame();
    await expect(moved.getByText('COMPLETED', { exact: true })).toBeVisible();
    const otherRepo = join(root, 'second-project');
    await mkdir(otherRepo);
    execFileSync('git', ['--no-optional-locks', 'init', '-q'], { cwd: otherRepo });
    await win.evaluate((path) => window.oxy.invoke('projects:add', { path }), otherRepo);
    await win.getByText('second-project', { exact: true }).first().click();
    await expect(moved.locator('.toolbar .eyebrow')).toContainText('second-project');
    await expect(moved.getByTestId('task-description')).toBeVisible();
    await expect(moved.getByLabel('Saved task')).toHaveCount(0);
    await win.evaluate((id) => window.oxy.invoke('projects:setActive', { id }), projectId);
    await expect(moved.locator('.toolbar .eyebrow')).toContainText('repo');
    await expect(moved.getByText('COMPLETED', { exact: true })).toBeVisible();
    await expect
      .poll(async () => (toolId = (await tools()).primaryTools.find((t) => t.panelType === 'task.panel')?.id ?? ''))
      .not.toBe('');
    await win.getByTestId(`section-header-${toolId}`).hover();
    await win.getByTestId(`move-tool-${toolId}`).click();
    await expect(win.getByTestId('plugin-panel-task.panel')).toBeVisible();
    await win.evaluate(() => window.oxy.invoke('plugins:executeCommand', { id: 'task.show' }));
    await expect(win.getByTestId('sidebar-tool-task.panel')).toHaveCount(0);
    await expect(win.getByTestId('plugin-panel-task.panel')).toHaveCount(1);
    moved = await currentFrame();
    await expect(moved.getByText('COMPLETED', { exact: true })).toBeVisible();

    // Changes uses the same picker and the existing idle Codex terminal, with an editable default prompt.
    await expect(win.getByTestId('changes-send-review')).toBeEnabled();
    await win.getByTestId('changes-send-review').click();
    await win.getByTestId('changes-review-agent').selectOption('ai:codex');
    await win.getByRole('button', { name: 'Review instruction', exact: true }).click();
    await win.screenshot({ path: test.info().outputPath('changes-review.png') });
    await win
      .getByTestId('changes-review-prompt')
      .fill('Review the uncommitted changes. List bugs. Do not edit files.');
    await win.getByRole('button', { name: 'Save as default', exact: true }).click();
    const count = (await oxyTest(win).terminalIds()).length;
    await win.getByTestId('changes-send-review-confirm').click();
    await expect(win.getByTestId('changes-send-review-dialog')).toHaveCount(0, { timeout: 20_000 });
    await expect.poll(() => oxyTest(win).text(codex)).toContain('List bugs');
    expect((await oxyTest(win).terminalIds()).length).toBe(count);
  } finally {
    await app.close();
  }
});

test('Task opens once in the right sidebar without a project', async () => {
  const { app, win } = await launchApp({ project: null });
  try {
    await expect(win.getByTestId('app-ready')).toBeVisible({ timeout: 30_000 });
    const frame = await taskFrame(win);
    await expect(frame.getByText('Open a project to plan a task.')).toBeVisible();
    await expect(frame.getByTestId('task-description')).toHaveCount(0);
    await taskFrame(win);
    await expect(win.getByTestId('sidebar-tool-task.panel')).toHaveCount(1);
    await win.screenshot({ path: test.info().outputPath('task-no-project.png') });
  } finally {
    await app.close();
  }
});
