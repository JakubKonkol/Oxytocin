import { z } from 'zod';
import { CodeMapQuerySchemas, type CodeMapQueryInput } from '@shared/domain/code-map-query';
import type { CodeMapService } from '../code-map/code-map-service';
import type { CoreTool } from './core-tools';
import { NO_PROJECT_MESSAGE } from './caller-context';
import { formatCodeMap, isStaleAnswer } from './code-map-format';

export const CODE_MAP_TOOL_KINDS = {
  oxy_code_map_status: 'status',
  oxy_repo_map: 'repo-map',
  oxy_find_code: 'search',
  oxy_file_outline: 'outline',
  oxy_code_relations: 'relations',
} as const;
/** A mistake the agent can correct (arguments, checkout selection): its message is shown to the agent. */
export class CodeMapToolInputError extends Error {}
export function isCodeMapTool(name: string): boolean {
  return Object.hasOwn(CODE_MAP_TOOL_KINDS, name);
}
const selectors = { cwd: z.string().min(1).max(32768).optional(), project: z.string().min(1).max(32768).optional() };
// What an agent is shown (every character is paid on each session). Parsing below uses the complete schemas, so the
// parameters left out here (freshness, maxChars, relation kinds, heuristic edges, project, format, symbolId) are still accepted.
const cwd = z.string().optional().describe('Your working directory');
const pathPrefix = z.string().optional().describe('Limit to this folder');
const advertised = {
  status: z.object({ cwd }),
  'repo-map': z.object({ cwd, pathPrefix }),
  search: z.object({ cwd, query: z.string().describe('The task or identifiers, in plain words'), pathPrefix }),
  outline: z.object({ cwd, path: z.string() }),
  relations: z.object({
    cwd,
    path: z.string(),
    line: z.number().optional().describe('Start line from a find_code answer: its symbol instead of the file'),
    direction: z.enum(['incoming', 'outgoing', 'both']).optional().describe('Default both'),
    depth: z.number().optional().describe('1-3, default 1'),
  }),
} as const;
const descriptions: Record<keyof typeof CODE_MAP_TOOL_KINDS, string> = {
  oxy_code_map_status: 'Code Map state, coverage and freshness.',
  oxy_repo_map: 'Folder layout, entry points and public APIs.',
  oxy_find_code:
    'Locate code from a task in plain words or identifiers: ranked path:lines with signatures. Not a text search.',
  oxy_file_outline: 'Definitions with line ranges and imports of one file.',
  oxy_code_relations:
    'Dependents (incoming) and dependencies (outgoing) of a file, or of the symbol at path:line. Indexed code only; not exhaustive.',
};
/** Relations budget the JSON envelope generously: what the agent pays for is the compact text, capped by the formatter. */
const RELATIONS_MAX_CHARS = 24000;
export function buildCodeMapTools(service: Pick<CodeMapService, 'query'>): CoreTool[] {
  return Object.entries(CODE_MAP_TOOL_KINDS).map(([name, kind]) => {
    const schema = CodeMapQuerySchemas[kind].safeExtend({
      ...selectors,
      format: z.enum(['compact', 'json']).default('compact'),
    });
    const inputSchema = {
      ...z.toJSONSchema(advertised[kind], { unrepresentable: 'any', io: 'input' }),
      type: 'object' as const,
    };
    delete inputSchema['$schema'];
    return {
      definition: {
        name,
        description: descriptions[name as keyof typeof descriptions],
        inputSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
        timeoutMs: 15_000,
      },
      defaultPolicy: 'allow',
      run: async ({ args, caller, signal, report }) => {
        const parsed = schema.safeParse(args);
        if (!parsed.success)
          throw new CodeMapToolInputError(
            `Invalid Code Map arguments: ${parsed.error.issues
              .slice(0, 3)
              .map((i) => [i.path.join('.'), i.message].filter(Boolean).join(' '))
              .join('; ')
              .slice(0, 300)}`,
          );
        if (caller.projectError || !caller.context.projectId)
          throw new CodeMapToolInputError(caller.projectError ?? NO_PROJECT_MESSAGE);
        const { cwd: _cwd, project: _project, format, ...options } = parsed.data;
        const explicitMaxChars = typeof args === 'object' && args !== null && 'maxChars' in args;
        const result = await service.query(
          caller.context.projectId,
          {
            ...options,
            ...(!explicitMaxChars && kind === 'relations' && format === 'compact'
              ? { maxChars: RELATIONS_MAX_CHARS }
              : {}),
            kind,
          } as CodeMapQueryInput,
          signal,
          caller.context.checkoutId,
        );
        report?.({ stale: isStaleAnswer(result), notOk: result.code !== 'OK' });
        return format === 'json' ? JSON.stringify(result) : formatCodeMap(result);
      },
    } satisfies CoreTool;
  });
}
