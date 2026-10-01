import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { EnsembleRecord, EnsembleTask } from '../../src/shared/domain/ensemble';
import { claudeConfigDir, gitIn, gitRepo, readLog, useFakeClaude, waitForStatus } from './helpers/ensemble';
import { launchApp } from './helpers/launch';
import { activeProjectId } from './helpers/terminal';

test("a two-agent Ensemble task runs in a worktree: the second agent gets the first one's plan, models and efforts are per agent, the user's settings and checkout stay untouched", async () => {
  const repo = await gitRepo();
  const claude = await claudeConfigDir();
  const before = await claude.hash();
  const log = join(await mkdtemp(join(tmpdir(), 'oxy-e2e-ens-log-')), 'agents.jsonl');
  const { app, win } = await launchApp({
    project: repo,
    env: { CLAUDE_CONFIG_DIR: claude.dir, FAKE_ENSEMBLE_LOG: log },
  });
  try {
    await useFakeClaude(win);
    const projectId = await activeProjectId(win);
    const created = (await win.evaluate(
      (p) => window.oxy.invoke('ensemble:create', { projectId: p, templateId: 'blank', title: 'CSV export' }),
      projectId,
    )) as EnsembleRecord;
    const planner = {
      id: 'ada',
      name: 'Ada',
      role: { preset: 'planner', label: 'Planner', color: 'violet' },
      cli: 'claude-code',
      model: 'opus',
      effort: 'xhigh',
      permissionMode: 'default',
      readOnly: true,
      rolePrompt: 'Plan carefully.',
      extraArgs: [],
      env: {},
    };
    const implementer = {
      ...planner,
      id: 'linus',
      name: 'Linus',
      role: { preset: 'implementer', label: 'Implementer', color: 'blue' },
      model: 'sonnet',
      effort: 'medium',
      readOnly: false,
    };
    const task: EnsembleTask = {
      ...created.task,
      description: 'Add CSV export to the reports page.',
      agents: [planner, implementer] as EnsembleTask['agents'],
      pipeline: [
        {
          id: 'plan',
          kind: 'agent',
          title: 'Plan',
          instruction: '',
          agentId: 'ada',
          output: 'plan',
          freshSession: false,
        },
        {
          id: 'impl',
          kind: 'agent',
          title: 'Implement',
          instruction: 'Implement this plan:\n{{plan}}',
          agentId: 'linus',
          output: 'implementation',
          freshSession: false,
        },
      ],
    };
    await win.evaluate((t) => window.oxy.invoke('ensemble:save', { task: t }), task);
    const started = (await win.evaluate(
      (id) => window.oxy.invoke('ensemble:command', { taskId: id, event: { type: 'start' } }),
      task.id,
    )) as {
      error?: string;
    };
    expect(started.error).toBeUndefined();
    const done = await waitForStatus(win, task.id, 'done', 90_000);

    const entries = await readLog(log);
    const starts = entries.filter((e) => e.event === 'start');
    expect(starts.map((s) => s.agent)).toEqual(['Ada', 'Linus']);
    const argsOf = (agent: string) => starts.find((s) => s.agent === agent)!.args!;
    expect(argsOf('Ada')).toEqual(
      expect.arrayContaining(['--model', 'opus', '--effort', 'xhigh', '--disallowedTools']),
    );
    expect(argsOf('Linus')).toEqual(expect.arrayContaining(['--model', 'sonnet', '--effort', 'medium']));
    expect(argsOf('Linus')).not.toContain('--disallowedTools');
    // Agents work in the task's worktree, not in the user's checkout.
    expect(done.run.worktree?.mode).toBe('worktree');
    expect(starts[0]!.cwd).toBe(done.run.worktree!.path);
    // The implementer's context contained the planner's result.
    const submit = entries.find((e) => e.agent === 'Linus' && e.tool === 'oxy_ensemble_submit');
    expect(submit?.text).toMatch(/Thanks/);
    const linusContext = entries.find((e) => e.agent === 'Linus' && e.tool === 'oxy_ensemble_context')!;
    expect(linusContext.text).toMatch(/### The plan \(by Ada\)\s+Ada saw:/);
    expect(done.run.handoffs.map((h) => h.summary)).toEqual(['Ada: plan done', 'Linus: implementation done']);
    expect(done.run.stages.map((s) => s.status)).toEqual(['done', 'done']);

    // Isolation: no slash commands, the settings file is byte-identical, the user's checkout is clean.
    expect(entries.filter((e) => e.event === 'message').every((e) => !e.text!.startsWith('/'))).toBe(true);
    expect(await claude.hash()).toBe(before);
    expect(gitIn(repo, 'status', '--porcelain')).toBe('');
    expect(gitIn(repo, 'branch', '--list', 'ensemble/*')).toContain('ensemble/csv-export');
  } finally {
    await app.close();
  }
});
