import type { EnsembleRun, EnsembleTask, Handoff } from '../domain/ensemble';
import { OUTPUT_LABELS } from '../domain/ensemble';
import { formatFindings, handoffText, systemPromptText, teamList } from './prompts';

export interface AgentContext {
  /** Markdown for the agent. */
  text: string;
  /** What it contains (the "who sees what" panel). */
  items: string[];
  structured: Record<string, unknown>;
}

const MAX_BODY = 24_000;
const cut = (s: string, n = MAX_BODY) =>
  s.length > n ? `${s.slice(0, n)}\n\n[… cut: ${s.length - n} more characters]` : s;

/**
 * What `oxy_ensemble_context` returns to an agent: who it is, the brief, its current instruction (variables
 * resolved), the inputs from earlier stages, the team, the notes board and the questions addressed to it.
 * `includeRole` adds layers 1–3 for CLIs without a system prompt file.
 */
export function agentContext(
  task: EnsembleTask,
  run: EnsembleRun,
  agentId: string,
  o: { includeRole: boolean },
): AgentContext {
  const agent = task.agents.find((a) => a.id === agentId);
  if (!agent) return { text: 'You are not part of this task.', items: [], structured: {} };
  const state = run.agents[agentId];
  const assignment = state?.assignment;
  const stage = assignment ? task.pipeline.find((s) => s.id === assignment.stageId) : undefined;
  const ws = run.worktree;
  const items: string[] = [];
  const sections: string[] = [];

  if (o.includeRole) {
    sections.push(systemPromptText(task, agent, { path: ws?.path, branch: ws?.branch, baseRef: ws?.baseRef }));
    items.push('role');
  }

  sections.push(
    `# Ensemble task: ${task.title}\n\nYou are **${agent.name}** (${agent.role.label}${agent.readOnly ? ', read-only' : ''}). Working folder: ${ws?.path ?? '(the project folder)'}${ws?.branch ? ` · branch ${ws.branch}` : ''}${ws?.baseRef ? ` · base ${ws.baseRef}${ws.baseCommit ? ` @ ${ws.baseCommit.slice(0, 7)}` : ''}` : ''}.`,
  );

  if (assignment) {
    const round = assignment.round ? ` · round ${assignment.round}` : '';
    sections.push(
      `## Your assignment${stage ? ` — stage "${stage.title}"` : ''}${round}\n\nSubmit with oxy_ensemble_submit, kind **"${assignment.output}"** (${OUTPUT_LABELS[assignment.output]}).\n\n${assignment.instruction}`,
    );
    items.push(`assignment: ${stage?.title ?? assignment.output}`);
  } else {
    sections.push(
      '## Your assignment\n\nNone right now. Wait: Oxytocin sends you a message when there is work for you.',
    );
  }

  if (task.description.trim()) {
    sections.push(`## The brief\n\n${cut(task.description.trim(), 30_000)}`);
    items.push('brief');
  }
  if (task.attachments.length) {
    sections.push(`## Read these files first\n\n${task.attachments.map((a) => `- ${a.path}`).join('\n')}`);
    items.push('attachments');
  }

  // Inputs: the latest result of every agent and the conductor's command output, the plan in full.
  const latest = new Map<string, Handoff>();
  for (const h of run.handoffs) if (h.agentId !== agentId || h.kind === 'plan') latest.set(`${h.agentId}:${h.kind}`, h);
  const plan = [...run.handoffs].reverse().find((h) => h.kind === 'plan');
  const inputs: string[] = [];
  if (plan) {
    inputs.push(
      `### The plan${plan.by === 'user' ? ' (edited and approved by the user)' : ` (by ${nameOf(task, plan.agentId)})`}\n\n${cut(handoffText(plan))}`,
    );
    items.push('plan');
  }
  for (const h of latest.values()) {
    if (h === plan) continue;
    const who = h.agentId === 'conductor' ? 'Command output' : `${nameOf(task, h.agentId)} — ${OUTPUT_LABELS[h.kind]}`;
    const lines = [`### ${who}${h.round ? ` (round ${h.round})` : ''}`, '', h.summary];
    if (h.verdict) lines.push('', `Verdict: ${h.verdict}`);
    if (h.findings?.length) lines.push('', 'Findings:', formatFindings(h.findings));
    if (h.body?.trim() && h.body.trim() !== h.summary.trim()) lines.push('', cut(h.body.trim(), 12_000));
    inputs.push(lines.join('\n'));
    items.push(
      h.agentId === 'conductor'
        ? 'command output'
        : `${nameOf(task, h.agentId)}'s ${OUTPUT_LABELS[h.kind].toLowerCase()}`,
    );
  }
  if (inputs.length) sections.push(`## Results so far\n\n${inputs.join('\n\n')}`);

  if (task.generalPrompt.trim() && !o.includeRole) {
    sections.push(`## Team instructions\n\n${task.generalPrompt.trim()}`);
    items.push('team instructions');
  }

  sections.push(`## The team\n\n${teamList(task)}`);

  if (run.notes.length) {
    sections.push(
      `## Notes board\n\n${run.notes
        .slice(-30)
        .map((n) => `- ${nameOf(task, n.by)}: ${n.text}`)
        .join('\n')}`,
    );
    items.push('notes');
  }
  const open = run.questions.filter((q) => q.to === agentId && q.answer === undefined);
  if (open.length) {
    sections.push(
      `## Questions for you\n\n${open.map((q) => `- ${q.id} from ${nameOf(task, q.from)}: ${q.question}`).join('\n')}\n\nAnswer with oxy_ensemble_answer.`,
    );
    items.push('questions');
  }
  const answered = run.questions.filter((q) => q.from === agentId && q.answer !== undefined).slice(-5);
  if (answered.length) {
    sections.push(
      `## Answers to your questions\n\n${answered.map((q) => `- ${q.question}\n  → ${nameOf(task, q.answeredBy ?? q.to)}: ${q.answer}`).join('\n')}`,
    );
    items.push('answers');
  }

  return {
    text: sections.join('\n\n'),
    items,
    structured: {
      task: { id: task.id, title: task.title },
      you: { id: agent.id, name: agent.name, role: agent.role.label, readOnly: agent.readOnly },
      workspace: ws
        ? { path: ws.path, branch: ws.branch ?? null, baseRef: ws.baseRef ?? null, baseCommit: ws.baseCommit ?? null }
        : null,
      assignment: assignment
        ? {
            stage: stage?.title ?? null,
            kind: assignment.output,
            round: assignment.round ?? null,
          }
        : null,
      team: task.agents.map((a) => ({ name: a.name, role: a.role.label })),
      openQuestions: open.map((q) => ({ id: q.id, from: nameOf(task, q.from), question: q.question })),
    },
  };
}

export function nameOf(task: EnsembleTask, id: string): string {
  if (id === 'user') return 'the user';
  if (id === 'conductor') return 'Oxytocin';
  return task.agents.find((a) => a.id === id)?.name ?? id;
}

/** A Markdown report of a run (a PR description). */
export function runReport(task: EnsembleTask, run: EnsembleRun, now: number): string {
  const lines: string[] = [`# ${task.title}`, ''];
  if (task.description.trim()) lines.push(task.description.trim(), '');
  const ms = run.activeMs + (run.runningSince !== undefined ? now - run.runningSince : 0);
  lines.push(
    `Built by an Ensemble of ${task.agents.length} agent${task.agents.length === 1 ? '' : 's'} in Oxytocin · ${Math.max(1, Math.round(ms / 60_000))} min${run.costUsd ? ` · $${run.costUsd.toFixed(2)}` : ''}${run.worktree?.branch ? ` · branch \`${run.worktree.branch}\`` : ''}`,
    '',
    '## Team',
    '',
    ...task.agents.map(
      (a) =>
        `- **${a.name}** — ${a.role.label} (${a.cli}${a.model ? ` · ${a.model}` : ''}${a.effort ? ` · ${a.effort}` : ''})`,
    ),
    '',
  );
  const plan = [...run.handoffs].reverse().find((h) => h.kind === 'plan');
  if (plan) lines.push('## Plan', '', handoffText(plan), '');
  lines.push('## Stages', '');
  for (const stage of task.pipeline) {
    const st = run.stages.find((s) => s.stageId === stage.id);
    lines.push(`- **${stage.title}** — ${st?.status ?? 'pending'}${st?.outcome ? `: ${st.outcome}` : ''}`);
  }
  const reviews = run.handoffs.filter((h) => h.kind === 'review');
  if (reviews.length) {
    lines.push('', '## Reviews', '');
    for (const r of reviews)
      lines.push(
        `- ${nameOf(task, r.agentId)}${r.round ? `, round ${r.round}` : ''}: **${r.verdict ?? 'n/a'}** — ${r.summary}${r.findings?.length ? ` (${r.findings.length} finding${r.findings.length === 1 ? '' : 's'})` : ''}`,
      );
  }
  const impl = [...run.handoffs].reverse().find((h) => h.kind === 'implementation');
  if (impl) {
    lines.push('', '## Changes', '', impl.summary);
    if (impl.files?.length) lines.push('', ...impl.files.map((f) => `- \`${f}\``));
  }
  const tests = [...run.handoffs].reverse().find((h) => h.agentId === 'conductor');
  if (tests) lines.push('', '## Tests', '', tests.summary);
  if (run.notes.length) lines.push('', '## Notes', '', ...run.notes.map((n) => `- ${nameOf(task, n.by)}: ${n.text}`));
  return `${lines.join('\n')}\n`;
}
