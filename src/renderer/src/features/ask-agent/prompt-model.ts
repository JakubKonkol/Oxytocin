/**
 * Prompts for AI agents built from code: a selection, a file's changes or review comments. Pure functions (unit
 * tested); the dialog and the review panel only collect the pieces.
 */

/** A piece of code the prompt is about. Lines are 1-based and inclusive. */
export interface CodeContext {
  /** Project-relative path. */
  path: string;
  startLine: number;
  endLine: number;
  code: string;
  languageId: string;
  /** The HEAD version (left side of a diff) rather than the file on disk. */
  original?: boolean;
}

/** A file whose uncommitted changes the prompt is about. */
export interface ChangesContext {
  path: string;
}

export type PromptContext =
  | { kind: 'code'; code: CodeContext }
  | { kind: 'changes'; changes: ChangesContext }
  /** A whole file (the agent reads it itself). */
  | { kind: 'file'; path: string };

export interface PromptPreset {
  id: string;
  label: string;
  /** Instruction for a selection of code. */
  code: string;
  /** Instruction for a file's uncommitted changes. */
  changes: string;
}

export const PROMPT_PRESETS: readonly PromptPreset[] = [
  {
    id: 'fix',
    label: 'Fix',
    code: 'Fix the problems in this code.',
    changes: 'Fix the problems in these changes.',
  },
  {
    id: 'explain',
    label: 'Explain',
    code: 'Explain what this code does and why. Do not change any files.',
    changes: 'Explain what these changes do and why. Do not change any files.',
  },
  {
    id: 'review',
    label: 'Review',
    code: 'Review this code: list bugs, unhandled edge cases and unclear parts, most important first. Do not change any files yet.',
    changes:
      'Review these changes: list bugs, unhandled edge cases and unclear parts, most important first. Do not change any files yet.',
  },
  {
    id: 'refactor',
    label: 'Refactor',
    code: 'Refactor this code to be simpler and easier to read without changing its behavior.',
    changes: 'Refactor these changes to be simpler and easier to read without changing their behavior.',
  },
  {
    id: 'tests',
    label: 'Add tests',
    code: 'Add tests that cover this code, including its edge cases.',
    changes: 'Add tests that cover these changes, including their edge cases.',
  },
  {
    id: 'document',
    label: 'Document',
    code: 'Add concise documentation comments to this code where they help.',
    changes: 'Add concise documentation comments to these changes where they help.',
  },
];

/** "line 4" or "lines 4–9". */
export function lineRange(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start}–${end}`;
}

/** Markdown fence language for a Monaco language id ('' when it would not help). */
export function fenceLanguage(languageId: string): string {
  return languageId === 'plaintext' ? '' : languageId;
}

/** A fenced code block whose fence is longer than any backtick run inside the code. */
export function fenced(code: string, languageId: string): string {
  const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${fenceLanguage(languageId)}\n${code.replace(/\n$/, '')}\n${fence}`;
}

/** Where a piece of code is: `src/a.ts`, lines 4–9 (in HEAD). */
export function describeCode(c: CodeContext): string {
  return `\`${c.path}\`, ${lineRange(c.startLine, c.endLine)}${c.original ? ' (the committed version, HEAD)' : ''}`;
}

export function contextBlock(context: PromptContext): string {
  if (context.kind === 'file') return `The file \`${context.path}\`.`;
  if (context.kind === 'changes')
    return `The uncommitted changes in \`${context.changes.path}\` (see \`git diff HEAD -- ${context.changes.path}\`).`;
  const c = context.code;
  return `${describeCode(c)}:\n\n${fenced(c.code, c.languageId)}`;
}

/** The instruction followed by the code (or the files) it is about. */
export function buildPrompt(instruction: string, contexts: readonly PromptContext[]): string {
  const blocks = contexts.map(contextBlock);
  return [instruction.trim(), ...blocks].filter(Boolean).join('\n\n');
}

/** The preset's instruction for these contexts (selections, or a file's changes). */
export function presetInstruction(preset: PromptPreset, contexts: readonly PromptContext[]): string {
  return contexts.length > 0 && contexts.every((c) => c.kind === 'changes') ? preset.changes : preset.code;
}

/** A review comment on a line range of a changed file. */
export interface ReviewComment {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  /** The commented code when the comment was written. */
  code: string;
  languageId: string;
  original?: boolean;
  text: string;
  createdAt: number;
}

/** The prompt that hands a whole review to an agent: every comment with the code it is about. */
export function reviewPrompt(comments: readonly ReviewComment[], intro?: string): string {
  const sorted = [...comments].sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);
  const head =
    intro?.trim() ||
    `Please address ${sorted.length === 1 ? 'this review comment' : `these ${sorted.length} review comments`} on the uncommitted changes. Fix what they ask for; when a comment is a question, answer it.`;
  const items = sorted.map((c, i) => {
    const where = describeCode(c);
    const code = c.code.trim() ? `\n\n${fenced(c.code, c.languageId)}` : '';
    return `${i + 1}. ${where}${code}\n\n${c.text.trim()}`;
  });
  return [head, ...items].join('\n\n');
}
