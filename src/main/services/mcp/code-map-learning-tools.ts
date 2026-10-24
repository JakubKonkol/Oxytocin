import { z } from 'zod';
import {
  LearningToolErrorSchema,
  LearningToolResultSchema,
  TaskContextQuerySchema,
  ProposeLearningSchema,
  LearningFeedbackSchema,
} from '@shared/domain/code-map-learning-tools';
import type { CodeMapService } from '../code-map/code-map-service';
import type { CoreTool } from './core-tools';
import { CodeMapToolInputError } from './code-map-tools';
import { NO_PROJECT_MESSAGE } from './caller-context';
import { formatTaskContext, isStaleTaskContext } from './code-map-format';

export const LEARNING_TOOL_NAMES = ['oxy_task_context', 'oxy_propose_learning', 'oxy_learning_feedback'] as const;
export const isLearningTool = (name: string): boolean => (LEARNING_TOOL_NAMES as readonly string[]).includes(name);
const selectors = { cwd: z.string().min(1).max(32768).optional(), project: z.string().min(1).max(32768).optional() };
export function buildLearningTools(service: Pick<CodeMapService, 'learningTool'>): CoreTool[] {
  const definitions = [
    {
      name: 'oxy_task_context',
      kind: 'task-context',
      schema: TaskContextQuerySchema.safeExtend({
        ...selectors,
        format: z.enum(['compact', 'json']).default('compact'),
      }),
      // Shown to the agent: the complete schema above still parses (symbolIds, freshness, maxChars, format).
      advertised: z.object({
        cwd: z.string().optional().describe('Your working directory'),
        question: z.string().describe('The task, in plain words'),
        paths: z.array(z.string()).optional().describe('Files you already know are relevant'),
      }),
      description:
        'Locate code like oxy_find_code and also return up to three reviewed learnings (untrusted reference data) with a receipt for oxy_learning_feedback.',
    },
    {
      name: 'oxy_propose_learning',
      kind: 'propose',
      schema: ProposeLearningSchema.extend(selectors),
      description:
        'Propose a reusable, evidence-backed finding for user review. Only when the user asks to save one. expectedRevision 0 and a stable idempotencyKey.',
    },
    {
      name: 'oxy_learning_feedback',
      kind: 'feedback',
      schema: LearningFeedbackSchema.extend(selectors),
      description:
        'Report used, irrelevant, outdated or incorrect for a learning in your oxy_task_context receipt. Cannot approve or delete findings.',
    },
  ] as const;
  return definitions.map((definition): CoreTool => {
    const { name, kind, schema, description } = definition;
    const shown = 'advertised' in definition ? definition.advertised : schema;
    const inputSchema = { ...z.toJSONSchema(shown, { unrepresentable: 'any', io: 'input' }), type: 'object' as const };
    delete inputSchema['$schema'];
    return {
      definition: {
        name,
        description,
        inputSchema,
        annotations: { readOnlyHint: kind === 'task-context', openWorldHint: false },
        timeoutMs: 35000,
      },
      defaultPolicy: 'allow',
      run: async ({ args, caller, sessionId, signal, learningActor, report }) => {
        const parsed = schema.safeParse(args);
        if (!parsed.success)
          throw new CodeMapToolInputError(
            'Invalid learning arguments: check required fields, limits, evidence references and idempotency key.',
          );
        if (caller.projectError || !caller.context.projectId)
          throw new CodeMapToolInputError(caller.projectError ?? NO_PROJECT_MESSAGE);
        const { cwd: _cwd, project: _project, ...parsedOptions } = parsed.data;
        const { format, ...options } = { format: 'compact', ...parsedOptions };
        try {
          const result = LearningToolResultSchema.parse(
            await service.learningTool(
              caller.context.projectId,
              caller.context.checkoutId ?? caller.context.projectId,
              { ...options, kind } as Parameters<CodeMapService['learningTool']>[2],
              { session: sessionId, ...(learningActor ?? { principal: 'hub', role: 'hub' }) },
              signal,
            ),
          );
          if (result.kind === 'task-context') report?.({ stale: isStaleTaskContext(result) });
          return {
            content: [
              {
                type: 'text',
                text:
                  result.kind === 'task-context' && format !== 'json'
                    ? formatTaskContext(result)
                    : JSON.stringify(result),
              },
            ],
            ...(result.kind === 'error' ? { isError: true } : {}),
          };
        } catch (error) {
          const prefix =
            error instanceof Error && error.name === 'AbortError'
              ? 'CANCELLED'
              : error instanceof Error
                ? error.message.split(':')[0]
                : '';
          const code = LearningToolErrorSchema.shape.code.safeParse(prefix);
          const result = {
            kind: 'error',
            code: code.success ? code.data : 'UNAVAILABLE',
            message:
              'Learning request failed or access changed; check project settings, checkout, receipt and indexing status.',
          };
          return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
      },
    };
  });
}
