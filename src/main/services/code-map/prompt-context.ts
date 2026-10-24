import type { CodeMapSettings } from '@shared/domain/code-map';
import type {
  CodeMapForgetPromptContextArgsSchema,
  CodeMapPromptContextArgs,
} from '@shared/domain/code-map-prompt-context';
import type { CodeMapQueryData, CodeMapQueryInput, CodeMapQueryResult } from '@shared/domain/code-map-query';
import type { Logger } from '@shared/logging/logger';
import { OxyError } from '@shared/errors';
import type { z } from 'zod';

/**
 * Prompt-time pointers (remediation plan, phase 4): with each prompt Claude Code sends through the Claude Code Bridge,
 * Oxytocin adds up to three file pointers to Claude's context, so most lookups need no Code Map tool call.
 *
 * Gate and limits are constants so the behavior is reviewable in one place. They are deliberately conservative: every
 * injected line is uncached input on each turn, so a wrong or repeated suggestion costs more than it saves. When the
 * match is weak nothing is injected at all (not even a "no strong match" hint): the agent would search normally
 * anyway, and the hint would only add input to every such prompt.
 *
 * The gate is the search's `strong` flag alone (the top hit matched the prompt in its own name, or is an exact
 * identifier or path). `coverage` is deliberately not used: the phase 2 measurements on the frozen corpus show it is
 * 0.93-1.0 for the top hit even when that hit is wrong, while `strong` was right in about 6 of 7 cases. A result
 * without `strong` (an older Code Map host) counts as weak.
 */
export const PROMPT_CONTEXT = {
  /** Shorter prompts ("yes", "continue", "fix it") carry no question to search. */
  minPromptChars: 12,
  /** Hard budget for the whole lookup; the hook itself times out after 5 s. Past it, nothing is injected. */
  budgetMs: 1000,
  /** Pointers per prompt. */
  maxPointers: 3,
  /** Pointers remembered per session (the oldest are forgotten first) and sessions remembered (least recently used). */
  maxPointersPerSession: 40,
  maxSessions: 1000,
  /** The longest search query the Code Map accepts. */
  maxQueryChars: 2000,
  /** Longest name or path printed in a pointer (they are repository text, not trusted). */
  maxPartChars: 120,
} as const;

/** Text the agent harness, not the user, sent as a prompt (task notifications, hook echoes, command output). */
const HARNESS_TEXT =
  /^\s*<(?:task-notification|system-reminder|command-(?:name|message|args|stdout)|local-command-[\w-]+|user-prompt-submit-hook|bash-(?:input|stdout|stderr)|teammate-message)\b/i;
/** A slash command without arguments (`/clear`, `/compact`) is not a question about the code. */
const BARE_SLASH_COMMAND = /^\s*\/\S+\s*$/;

/** Pointers already injected per (terminal, session), bounded in both dimensions. */
export class InjectedPointers {
  private readonly sessions = new Map<string, Set<string>>();

  private key(terminalId: string, sessionId: string): string {
    return `${terminalId}\0${sessionId}`;
  }

  has(terminalId: string, sessionId: string, pointer: string): boolean {
    return this.sessions.get(this.key(terminalId, sessionId))?.has(pointer) ?? false;
  }

  add(terminalId: string, sessionId: string, pointers: readonly string[]): void {
    const key = this.key(terminalId, sessionId);
    const known = this.sessions.get(key) ?? new Set<string>();
    // Re-insert so the session counts as recently used.
    this.sessions.delete(key);
    this.sessions.set(key, known);
    for (const pointer of pointers) {
      known.delete(pointer);
      known.add(pointer);
    }
    while (known.size > PROMPT_CONTEXT.maxPointersPerSession) known.delete(known.values().next().value!);
    while (this.sessions.size > PROMPT_CONTEXT.maxSessions) this.sessions.delete(this.sessions.keys().next().value!);
  }

  forget(terminalId: string, sessionId: string): void {
    this.sessions.delete(this.key(terminalId, sessionId));
  }

  get size(): number {
    return this.sessions.size;
  }
}

export interface PromptContextDeps {
  /**
   * The project and checkout of a terminal, chosen like for an MCP tool call from that terminal (an Ensemble worktree
   * resolves to its own checkout); null when the terminal has none.
   */
  resolve(terminalId: string): Promise<{ projectId: string; checkoutId?: string } | null>;
  /** The Code Map settings of a project (undefined: never configured). */
  settings(projectId: string): CodeMapSettings | undefined;
  query(
    projectId: string,
    input: CodeMapQueryInput,
    signal: AbortSignal,
    checkoutId?: string,
  ): Promise<CodeMapQueryResult>;
  logger: Logger;
  /** Test hook: the lookup budget in milliseconds. */
  budgetMs?: number;
}

/** One line of text: repository text can never add lines or control characters to the injection. */
const oneLine = (text: string, max: number) => {
  const line = text.replace(/[\p{Cc}\s]+/gu, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

type SearchData = Extract<CodeMapQueryData, { kind: 'search' }>;
type Match = SearchData['matches'][number];

const HEADER = 'Code Map — likely relevant code (read before editing):';

/** `path:start-end kind name`; a hit whose lines may lag the index (`stale`) is named without lines. */
function pointerLine(match: Match): string {
  const path = oneLine(match.path, PROMPT_CONTEXT.maxPartChars);
  if (match.kind === 'file') return `${path} file`;
  const lines = match.span && !match.stale ? `:${match.span[0]}-${match.span[2]}` : '';
  return `${path}${lines} ${oneLine(match.kind, 40)} ${oneLine(match.name, PROMPT_CONTEXT.maxPartChars)}`;
}

/** The confidence gate: the top hit must be strong (see `PROMPT_CONTEXT`); coverage alone never passes. */
export function passesGate(data: { strong?: boolean | undefined }): boolean {
  return data.strong === true;
}

/** Whether a prompt is worth a lookup: long enough and typed by the user (not harness text). */
export function isSearchablePrompt(prompt: string): boolean {
  const text = prompt.trim();
  return text.length >= PROMPT_CONTEXT.minPromptChars && !HARNESS_TEXT.test(text) && !BARE_SLASH_COMMAND.test(text);
}

export class CodeMapPromptContext {
  private readonly injected = new InjectedPointers();

  constructor(private readonly deps: PromptContextDeps) {}

  /** Pointers to add to Claude's context for this prompt, or null (nothing to add is the normal answer). */
  async suggest(args: CodeMapPromptContextArgs): Promise<{ text: string } | null> {
    // Never put the prompt, or anything derived from it, into a log line: only the outcome and timings.
    const started = performance.now();
    const done = (outcome: string, pointers = 0): null => {
      this.deps.logger.debug(`Code Map prompt context: ${outcome}`, {
        pointers,
        ms: Math.round(performance.now() - started),
      });
      return null;
    };
    try {
      // The setting comes first: while it is off the prompt text is not even looked at.
      const checkout = await this.deps.resolve(args.terminalId);
      const settings = checkout ? this.deps.settings(checkout.projectId) : undefined;
      if (!checkout || !settings?.enabled || settings.promptSuggestions !== true) return done('off');
      const prompt = args.prompt.trim().slice(0, PROMPT_CONTEXT.maxQueryChars);
      if (!isSearchablePrompt(prompt)) return done('skipped');
      const result = await this.search(checkout, prompt);
      const data = result?.code === 'OK' ? result.data : undefined;
      if (data?.kind !== 'search') return done('no answer');
      if (!passesGate(data)) return done('weak match');
      const fresh = data.matches
        .filter((m) => !this.injected.has(args.terminalId, args.sessionId, m.id))
        .slice(0, PROMPT_CONTEXT.maxPointers);
      if (!fresh.length) return done('already suggested');
      this.injected.add(
        args.terminalId,
        args.sessionId,
        fresh.map((m) => m.id),
      );
      this.deps.logger.debug('Code Map prompt context: suggested', {
        pointers: fresh.length,
        ms: Math.round(performance.now() - started),
      });
      return { text: [HEADER, ...fresh.map(pointerLine)].join('\n') };
    } catch (error) {
      // An error's message may quote the query, so only its code is logged.
      return done(`failed (${error instanceof OxyError ? error.code : 'error'})`);
    }
  }

  forget(args: z.infer<typeof CodeMapForgetPromptContextArgsSchema>): void {
    this.injected.forget(args.terminalId, args.sessionId);
  }

  private async search(
    checkout: { projectId: string; checkoutId?: string },
    prompt: string,
  ): Promise<CodeMapQueryResult | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, this.deps.budgetMs ?? PROMPT_CONTEXT.budgetMs);
    });
    const query = this.deps
      .query(
        checkout.projectId,
        { kind: 'search', query: prompt, limit: PROMPT_CONTEXT.maxPointers, freshness: 'allow-stale', maxChars: 2000 },
        controller.signal,
        checkout.checkoutId,
      )
      // A query that loses the race finishes (or fails) later; nothing may reject unhandled.
      .catch((error: unknown) => {
        if (controller.signal.aborted) return null;
        throw error;
      });
    try {
      return await Promise.race([query, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
