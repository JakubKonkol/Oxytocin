import { z } from 'zod';

/** The most prompt text (characters) the prompt-time lookup accepts; the Claude Code Bridge cuts longer prompts. */
export const PROMPT_CONTEXT_MAX_PROMPT_CHARS = 4000;
/** Arguments of the core command `oxytocin.codeMap.promptContext` (the Claude Code Bridge's `UserPromptSubmit` hook). */
export const CodeMapPromptContextArgsSchema = z
  .object({
    terminalId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    prompt: z.string().max(PROMPT_CONTEXT_MAX_PROMPT_CHARS),
  })
  .strict();
export type CodeMapPromptContextArgs = z.infer<typeof CodeMapPromptContextArgsSchema>;

/** Arguments of `oxytocin.codeMap.forgetPromptContext` (`SessionEnd`): drops what was suggested in a session. */
export const CodeMapForgetPromptContextArgsSchema = CodeMapPromptContextArgsSchema.omit({ prompt: true }).strict();
