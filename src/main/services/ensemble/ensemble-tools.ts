import type { McpToolDefinition, McpToolResult } from '@shared/domain/mcp';
import { SubmissionSchema } from '@shared/domain/ensemble';

/** What the tools need from the service: every call is already resolved to its task and agent. */
export interface EnsembleToolHost {
  context(taskId: string, agentId: string): { text: string; structured: Record<string, unknown> };
  submit(taskId: string, agentId: string, submission: unknown): { reply?: string; error?: string };
  progress(taskId: string, agentId: string, message: string, percent?: number): void;
  ask(
    taskId: string,
    agentId: string,
    to: string,
    question: string,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<{ error?: string; answer?: string; questionId?: string }>;
  answer(taskId: string, agentId: string, questionId: string, answer: string): { reply?: string; error?: string };
  note(taskId: string, agentId: string, text: string): { reply?: string; error?: string };
  delegate(taskId: string, agentId: string, to: string, work: string): { reply?: string; error?: string };
}

const ok = (text: string, structured?: Record<string, unknown>): McpToolResult => ({
  content: [{ type: 'text', text }],
  ...(structured ? { structuredContent: structured } : {}),
});
const fail = (text: string): McpToolResult => ({ content: [{ type: 'text', text }], isError: true });
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export const ENSEMBLE_TOOLS: McpToolDefinition[] = [
  {
    name: 'oxy_ensemble_context',
    title: 'Ensemble: my assignment',
    description:
      "Your current Ensemble assignment: who you are in the team, the brief, your instruction (with the stage, round and the kind to submit), the results of earlier stages (the plan, review findings, test output, other agents' handoffs), the team, the notes board and questions addressed to you. Call it whenever you get a new assignment or message from Ensemble.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'oxy_ensemble_submit',
    title: 'Ensemble: submit my result',
    description:
      'Finishes your part of the current stage and hands the result on. `kind` must be the kind your assignment names. A review needs `verdict` ("approve" or "changes") and, for "changes", `findings`. Advice (advisor only) needs `target`. Returns what happens next.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['plan', 'implementation', 'review', 'test-report', 'research', 'advice', 'free'],
          description: 'The kind your assignment asks for.',
        },
        summary: { type: 'string', description: 'One to three sentences: what you did or found.' },
        body: { type: 'string', description: 'The full result in Markdown (the plan, the review, the report…).' },
        verdict: { type: 'string', enum: ['approve', 'changes'], description: 'Reviews only.' },
        findings: {
          type: 'array',
          description: 'Reviews: what must change.',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string' },
              line: { type: 'number' },
              severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
              message: { type: 'string' },
            },
            required: ['message'],
          },
        },
        files: { type: 'array', items: { type: 'string' }, description: 'Files you changed (implementations).' },
        target: { type: 'string', description: 'Advice only: the agent name it is for, or "user".' },
      },
      required: ['kind', 'summary'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'oxy_ensemble_progress',
    title: 'Ensemble: report progress',
    description:
      'Shows one short line about what you are doing on your card in Oxytocin ("Writing tests for CsvExporter"). Optional `percent`. Use it on long work, not on every step.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' }, percent: { type: 'number', minimum: 0, maximum: 100 } },
      required: ['message'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'oxy_ensemble_ask',
    title: 'Ensemble: ask a teammate or the user',
    description:
      'Asks another agent of the team (by name) or the user ("user") a question and waits for the answer (default up to 2 minutes for an agent, 5 for the user). If no answer comes in time, continue: the answer is delivered to you as a message later.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'An agent name from the team, or "user".' },
        question: { type: 'string' },
        wait_seconds: { type: 'number', description: 'How long to wait (0–540). 0: do not wait.' },
      },
      required: ['to', 'question'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    timeoutMs: 600_000,
  },
  {
    name: 'oxy_ensemble_delegate',
    title: 'Ensemble: delegate work to a teammate',
    description:
      "Hands a piece of your current work to another agent of the team (by name or role), e.g. the planner asks the API researcher to map the endpoints the task needs, or a researcher to find how something works in the code. Describe exactly what you need back. Returns at once; the teammate's report is delivered to you as a message when it submits (and appears in oxy_ensemble_context). Delegate to several teammates in parallel, then wait for their reports before you submit your own result.",
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'A teammate: its name or role ("API researcher").' },
        work: { type: 'string', description: 'What to do and what to report back (Markdown).' },
      },
      required: ['to', 'work'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'oxy_ensemble_answer',
    title: 'Ensemble: answer a question',
    description: 'Answers a question another agent asked you (its id is in the message and in oxy_ensemble_context).',
    inputSchema: {
      type: 'object',
      properties: { questionId: { type: 'string' }, answer: { type: 'string' } },
      required: ['questionId', 'answer'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'oxy_ensemble_note',
    title: 'Ensemble: post a note',
    description:
      "Posts a note on the task's board (a decision, a gotcha) that every agent sees in oxy_ensemble_context and the user sees in the Activity view.",
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

const clampSeconds = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(540, Math.round(v))) : fallback;

/** Runs an Ensemble tool for the agent the call's role token belongs to. */
export async function runEnsembleTool(
  host: EnsembleToolHost,
  name: string,
  args: Record<string, unknown>,
  who: { taskId: string; agentId: string },
  signal: AbortSignal,
): Promise<McpToolResult> {
  const { taskId, agentId } = who;
  switch (name) {
    case 'oxy_ensemble_context': {
      const c = host.context(taskId, agentId);
      return ok(c.text, c.structured);
    }
    case 'oxy_ensemble_submit': {
      const parsed = SubmissionSchema.safeParse(args);
      if (!parsed.success)
        return fail(
          `The submission is not valid: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ')}`,
        );
      const r = host.submit(taskId, agentId, parsed.data);
      return r.error ? fail(r.error) : ok(r.reply ?? 'Submitted.');
    }
    case 'oxy_ensemble_progress': {
      const message = str(args['message']).trim();
      if (!message) return fail('Pass `message`.');
      const percent = typeof args['percent'] === 'number' ? Math.max(0, Math.min(100, args['percent'])) : undefined;
      host.progress(taskId, agentId, message, percent);
      return ok('Shown on your card.');
    }
    case 'oxy_ensemble_ask': {
      const to = str(args['to']).trim();
      const question = str(args['question']).trim();
      if (!to || !question) return fail('Pass `to` and `question`.');
      const toUser = /^(user|you)$/i.test(to);
      const seconds = clampSeconds(args['wait_seconds'], toUser ? 300 : 120);
      const r = await host.ask(taskId, agentId, to, question, seconds * 1000, signal);
      if (r.error) return fail(r.error);
      if (r.answer !== undefined) return ok(`Answer: ${r.answer}`);
      return ok(
        seconds === 0
          ? `Question ${r.questionId} sent. The answer will be delivered to you as a message.`
          : `No answer yet (question ${r.questionId}). Continue with your work; the answer will be delivered to you as a message.`,
      );
    }
    case 'oxy_ensemble_answer': {
      const questionId = str(args['questionId']).trim();
      const answer = str(args['answer']).trim();
      if (!questionId || !answer) return fail('Pass `questionId` and `answer`.');
      const r = host.answer(taskId, agentId, questionId, answer);
      return r.error ? fail(r.error) : ok(r.reply ?? 'Answered.');
    }
    case 'oxy_ensemble_delegate': {
      const to = str(args['to']).trim();
      const work = str(args['work']).trim();
      if (!to || !work) return fail('Pass `to` and `work`.');
      const r = host.delegate(taskId, agentId, to, work);
      return r.error ? fail(r.error) : ok(r.reply ?? 'Delegated.');
    }
    case 'oxy_ensemble_note': {
      const text = str(args['text']).trim();
      if (!text) return fail('Pass `text`.');
      const r = host.note(taskId, agentId, text);
      return r.error ? fail(r.error) : ok(r.reply ?? 'Noted.');
    }
    default:
      return fail(`Unknown tool ${name}.`);
  }
}
