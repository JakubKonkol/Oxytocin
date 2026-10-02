import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  claudeConfigDir,
  ensembleRecords,
  gitIn,
  gitRepo,
  readLog,
  useFakeClaude,
  waitForStatus,
} from './helpers/ensemble';
import { launchApp } from './helpers/launch';

test('Ensemble: a feature task runs plan → gate → implement ⇄ review → tests → gate in its worktree and is merged', async () => {
  test.setTimeout(180_000);
  const repo = await gitRepo();
  // The test stage fails until the implementer wrote fixed.txt.
  await writeFile(join(repo, 'check.js'), "process.exit(require('fs').existsSync('fixed.txt') ? 0 : 1);\n");
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'check');
  const claude = await claudeConfigDir();
  const before = await claude.hash();
  const dir = await mkdtemp(join(tmpdir(), 'oxy-e2e-ens-'));
  const log = join(dir, 'agents.jsonl');
  const script = join(dir, 'script.json');
  await writeFile(
    script,
    JSON.stringify({
      Grace: [{ verdict: 'changes' }, { verdict: 'approve' }],
      Linus: [{}, {}, { writeFile: 'fixed.txt' }],
    }),
  );
  const { app, win } = await launchApp({
    project: repo,
    env: { CLAUDE_CONFIG_DIR: claude.dir, FAKE_ENSEMBLE_LOG: log, FAKE_ENSEMBLE_SCRIPT: script },
  });
  try {
    await useFakeClaude(win);
    // The "+" menu of the workspace group opens Ensemble.
    await win.getByTestId('group-add').first().click();
    await win.getByTestId('add-tool-ensemble').click();
    const panel = win.getByTestId('ensemble-panel');
    await expect(panel.getByTestId('ensemble-new-task-view')).toBeVisible();
    await panel.getByTestId('ensemble-new-mode').locator('[data-value="template"]').click();
    await panel.getByTestId('ensemble-template-feature').click();
    await panel.getByTestId('ensemble-new-title').fill('CSV export');
    await panel.getByTestId('ensemble-new-description').fill('Add CSV export to the reports page.');
    await panel.getByTestId('ensemble-create').click();

    // The builder: the template's team and pipeline; the test command is changed.
    await expect(panel.getByTestId('ensemble-agent-card')).toHaveCount(3);
    await panel.locator('[data-testid="ensemble-stage-card"][data-stage-id="tests"]').click();
    await panel.getByTestId('ensemble-stage-command').fill('node check.js');
    await expect(panel.getByTestId('ensemble-save-state')).toHaveText('Saved');
    await panel.getByTestId('ensemble-start').click();

    // Plan, then the plan gate.
    await expect(panel.getByTestId('ensemble-flow')).toBeVisible();
    await panel.getByTestId('ensemble-open-gate').click();
    const gate = win.getByTestId('ensemble-gate-dialog');
    await expect(gate).toContainText('Ada saw:');
    await gate.getByTestId('ensemble-gate-approve').click();
    await expect(gate).toBeHidden();
    await expect(panel.getByTestId('ensemble-open-gate')).toBeHidden();

    // Implement ⇄ review (two rounds), the failing command goes back to Linus, then the final gate.
    await expect(panel.getByTestId('ensemble-open-gate')).toBeVisible({ timeout: 90_000 });
    const mid = (await ensembleRecords(win))[0]!;
    expect(mid.run.stages.find((s) => s.stageId === 'implement')).toMatchObject({ status: 'done', round: 2 });
    expect(mid.run.stages.find((s) => s.stageId === 'tests')).toMatchObject({ status: 'done', attempts: 2 });
    await expect(panel.getByTestId('ensemble-decisions')).toContainText('back to Linus');
    await panel.getByTestId('ensemble-open-gate').click();
    await win.getByTestId('ensemble-gate-dialog').getByTestId('ensemble-gate-approve').click();

    const done = await waitForStatus(win, mid.task.id, 'done');
    expect(done.run.checkpoints.length).toBeGreaterThan(0);
    // The planner and the reviewer never got a slash command; models and efforts are per agent.
    const starts = (await readLog(log)).filter((e) => e.event === 'start');
    const args = (agent: string) => starts.find((s) => s.agent === agent)!.args!;
    expect(args('Ada')).toEqual(expect.arrayContaining(['--model', 'claude-opus-5-5', '--effort', 'xhigh']));
    expect(args('Grace')).toEqual(expect.arrayContaining(['--model', 'claude-sonnet-5-5', '--effort', 'high']));
    expect(await claude.hash()).toBe(before);
    expect(existsSync(join(repo, 'fixed.txt'))).toBe(false);

    // Finish: merge the branch into main.
    await panel.getByTestId('ensemble-open-finish').click();
    const finish = win.getByTestId('ensemble-finish-dialog');
    await finish.getByTestId('ensemble-finish-merge').click();
    await finish.getByTestId('ensemble-finish-run').click();
    await expect(finish).toBeHidden({ timeout: 30_000 });
    expect(existsSync(join(repo, 'fixed.txt'))).toBe(true);
    expect(gitIn(repo, 'log', '--oneline', '-5')).toMatch(/Merge branch 'ensemble\/csv-export'/);
    expect(gitIn(repo, 'status', '--porcelain')).toBe('');
    await expect(panel.getByTestId('ensemble-needs')).toBeHidden();
  } finally {
    await app.close();
  }
});

test('Ensemble: a peeked agent can be taken over and handed back; a read-only team works in the current checkout', async () => {
  const repo = await gitRepo();
  const claude = await claudeConfigDir();
  const dir = await mkdtemp(join(tmpdir(), 'oxy-e2e-ens-'));
  const script = join(dir, 'script.json');
  // The researcher keeps working long enough to be watched.
  await writeFile(script, JSON.stringify({ Rosalind: [{ waitMs: 5000 }] }));
  const { app, win } = await launchApp({
    project: repo,
    env: { CLAUDE_CONFIG_DIR: claude.dir, FAKE_ENSEMBLE_LOG: join(dir, 'log.jsonl'), FAKE_ENSEMBLE_SCRIPT: script },
  });
  try {
    await useFakeClaude(win);
    await win.getByTestId('group-add').first().click();
    await win.getByTestId('add-tool-ensemble').click();
    const panel = win.getByTestId('ensemble-panel');
    await panel.getByTestId('ensemble-new-mode').locator('[data-value="template"]').click();
    await panel.getByTestId('ensemble-template-research').click();
    await panel.getByTestId('ensemble-new-title').fill('Spike');
    await panel.getByTestId('ensemble-create').click();
    await panel.getByTestId('ensemble-workspace-mode').locator('[data-value="current-checkout"]').click();
    await expect(panel.getByTestId('ensemble-save-state')).toHaveText('Saved');
    await panel.getByTestId('ensemble-start').click();
    const node = panel.locator('[data-testid="ensemble-agent-node"]').first();
    await expect(node).toHaveAttribute('data-state', 'working', { timeout: 20_000 });
    await node.click();
    const drawer = panel.getByTestId('ensemble-drawer');
    await expect(drawer.locator('.xterm')).toBeVisible();
    await drawer.getByTestId('ensemble-take-over').click();
    await expect(drawer.getByTestId('ensemble-take-over')).toHaveText(/Hand back/);
    await drawer.getByTestId('ensemble-take-over').click();
    await drawer.getByTestId('ensemble-drawer-close').click();
    const id = (await ensembleRecords(win))[0]!.task.id;
    await waitForStatus(win, id, 'running');
    const events = (await ensembleRecords(win))[0]!.run.events.map((e) => e.text);
    expect(events).toEqual(expect.arrayContaining(['You took over Rosalind', 'You handed Rosalind back']));
    // A read-only team in the current checkout: no worktree, the stage runs to the gate.
    await expect(panel.getByTestId('ensemble-open-gate')).toBeVisible({ timeout: 60_000 });
    expect((await ensembleRecords(win))[0]!.run.worktree?.mode).toBe('current-checkout');
    await panel.getByTestId('ensemble-open-gate').click();
    await win.getByTestId('ensemble-gate-dialog').getByTestId('ensemble-gate-approve').click();
    await waitForStatus(win, id, 'done');
    // Done in the current checkout: nothing to finish.
    await expect(panel.getByTestId('ensemble-finish')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('Ensemble: agent costs come from the Usage Monitor and the budget pauses the task', async () => {
  test.setTimeout(120_000);
  const repo = await gitRepo();
  const claude = await claudeConfigDir();
  await mkdir(join(claude.dir, 'projects'), { recursive: true });
  const dir = await mkdtemp(join(tmpdir(), 'oxy-e2e-ens-'));
  const script = join(dir, 'script.json');
  // 100k output tokens of claude-opus-5-5 cost $2.00 (built-in prices); the researcher keeps working meanwhile.
  await writeFile(
    script,
    JSON.stringify({ Rosalind: [{ usage: { model: 'claude-opus-5-5', output: 100_000 }, waitMs: 60_000 }] }),
  );
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ 'usage.pricing.autoUpdate': false }));
  const { app, win } = await launchApp({
    userData,
    project: repo,
    env: { CLAUDE_CONFIG_DIR: claude.dir, FAKE_ENSEMBLE_LOG: join(dir, 'log.jsonl'), FAKE_ENSEMBLE_SCRIPT: script },
  });
  try {
    await useFakeClaude(win);
    await win.getByTestId('group-add').first().click();
    await win.getByTestId('add-tool-ensemble').click();
    const panel = win.getByTestId('ensemble-panel');
    await panel.getByTestId('ensemble-new-mode').locator('[data-value="template"]').click();
    await panel.getByTestId('ensemble-template-research').click();
    await panel.getByTestId('ensemble-new-title').fill('Costly spike');
    await panel.getByTestId('ensemble-create').click();
    await panel.getByTestId('ensemble-workspace-mode').locator('[data-value="current-checkout"]').click();
    await panel.getByTestId('ensemble-budget').fill('1');
    await expect(panel.getByTestId('ensemble-save-state')).toHaveText('Saved');
    await panel.getByTestId('ensemble-start').click();

    const id = (await ensembleRecords(win))[0]!.task.id;
    const paused = await waitForStatus(win, id, 'paused', 60_000);
    expect(paused.run.pauseReason).toBe('The budget of $1 is reached');
    expect(paused.run.costUsd).toBeCloseTo(2, 2);
    await expect(panel.getByTestId('ensemble-agent-cost').first()).toHaveText('$2.00');
    await expect(panel.getByTestId('ensemble-run-cost')).toHaveText('$2.00 of $1.00');
    await win.evaluate((taskId) => window.oxy.invoke('ensemble:command', { taskId, event: { type: 'stop' } }), id);
    await waitForStatus(win, id, 'stopped');
  } finally {
    await app.close();
  }
});

test('Ensemble quick start: one prompt and a team; the planner delegates to the API researcher, you approve, the implementer builds', async () => {
  test.setTimeout(120_000);
  const repo = await gitRepo();
  const claude = await claudeConfigDir();
  const dir = await mkdtemp(join(tmpdir(), 'oxy-e2e-ens-'));
  const log = join(dir, 'agents.jsonl');
  const script = join(dir, 'script.json');
  await writeFile(
    script,
    JSON.stringify({
      Ada: [{ delegate: [{ to: 'API researcher', work: 'Map GET /weather and its response shape.' }] }],
      Tim: [{ waitMs: 3000 }],
    }),
  );
  const { app, win } = await launchApp({
    project: repo,
    env: { CLAUDE_CONFIG_DIR: claude.dir, FAKE_ENSEMBLE_LOG: log, FAKE_ENSEMBLE_SCRIPT: script },
  });
  try {
    await useFakeClaude(win);
    await win.getByTestId('group-add').first().click();
    await win.getByTestId('add-tool-ensemble').click();
    const panel = win.getByTestId('ensemble-panel');
    await expect(panel.getByTestId('ensemble-quick-start')).toBeVisible();
    await panel
      .getByTestId('ensemble-quick-prompt')
      .fill('Show the current weather on the dashboard.\nUse the Weather API at https://api.example.com/docs.');
    // Default team: implementer and reviewer; this task wants the API researcher instead of the reviewer.
    await expect(panel.getByTestId('ensemble-quick-role-implementer')).toHaveAttribute('aria-pressed', 'true');
    await panel.getByTestId('ensemble-quick-role-reviewer').click();
    await panel.getByTestId('ensemble-quick-role-api-researcher').click();
    await expect(panel.getByTestId('ensemble-quick-apis')).toContainText('Name the API');
    await panel.getByTestId('ensemble-quick-go').click();

    // The planner delegated: the researcher shows up under the plan stage.
    await expect(panel.getByTestId('ensemble-flow')).toBeVisible();
    await expect(panel.getByTestId('ensemble-stage-helpers')).toContainText('Tim', { timeout: 30_000 });
    await expect(panel.getByTestId('ensemble-agent-waiting-for')).toHaveText('· waiting for Tim');
    await panel.getByTestId('ensemble-open-gate').click();
    const gate = win.getByTestId('ensemble-gate-dialog');
    await expect(gate).toContainText('Report from Tim');
    await gate.getByTestId('ensemble-gate-approve').click();
    const id = (await ensembleRecords(win))[0]!.task.id;
    const done = await waitForStatus(win, id, 'done', 60_000);
    expect(done.task.title).toBe('Show the current weather on the dashboard');
    expect(done.task.agents.map((a) => a.name)).toEqual(['Ada', 'Linus', 'Tim']);
    expect(done.run.handoffs.map((h) => [h.agentId, h.kind])).toEqual([
      ['tim', 'research'],
      ['ada', 'plan'],
      ['linus', 'implementation'],
    ]);
    const entries = await readLog(log);
    // Tim got the delegated work with the brief; Linus got the plan and Tim's report.
    const timMessage = entries.find((e) => e.agent === 'Tim' && e.event === 'message')!.text!;
    expect(timMessage).toMatch(/^\[Ensemble\] Ada \(Planner\) delegated work to you/);
    expect(timMessage).toContain('Map GET /weather and its response shape.');
    expect(timMessage).toContain('https://api.example.com/docs');
    const linusMessage = entries.find((e) => e.agent === 'Linus' && e.event === 'message')!.text!;
    expect(linusMessage).toContain('Tim — Research');
    const starts = entries.filter((e) => e.event === 'start' && e.args?.includes('--mcp-config'));
    expect(starts.find((s) => s.agent === 'Ada')!.args).toEqual(expect.arrayContaining(['--model', 'claude-opus-5-5']));
    expect(starts.find((s) => s.agent === 'Tim')!.args).toEqual(
      expect.arrayContaining(['--allowedTools', 'mcp__oxytocin-ensemble', 'WebFetch']),
    );
  } finally {
    await app.close();
  }
});

test('Ensemble: "Customize first" opens the builder; every model of the CLI can be picked, or any other id', async () => {
  const repo = await gitRepo();
  const { app, win } = await launchApp({ project: repo });
  try {
    await useFakeClaude(win);
    await win.getByTestId('group-add').first().click();
    await win.getByTestId('add-tool-ensemble').click();
    const panel = win.getByTestId('ensemble-panel');
    await panel.getByTestId('ensemble-quick-prompt').fill('Refactor the exporter');
    await panel.getByTestId('ensemble-quick-customize').click();
    await expect(panel.getByTestId('ensemble-builder')).toBeVisible();
    const ada = panel.locator('[data-testid="ensemble-agent-card"][data-agent-id="ada"]');
    const model = ada.getByTestId('ensemble-agent-model');
    await expect(model).toHaveValue('claude-opus-5-5');
    // Every model is offered, whatever is selected (a datalist used to filter them by the current value).
    const options = await model.locator('option').allTextContents();
    expect(options.length).toBeGreaterThanOrEqual(10);
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-4-5', 'opus'])
      expect(options.some((o) => o.startsWith(id))).toBe(true);
    await model.selectOption('claude-sonnet-5-5');
    await model.selectOption('__custom__');
    await ada.getByTestId('ensemble-agent-model-custom').fill('claude-opus-5');
    await expect(panel.getByTestId('ensemble-save-state')).toHaveText('Saved');
    const record = (await ensembleRecords(win))[0]!;
    expect(record.task.agents.find((a) => a.id === 'ada')!.model).toBe('claude-opus-5');
    expect(record.run.status).toBe('draft');
  } finally {
    await app.close();
  }
});
