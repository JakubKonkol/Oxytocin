import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  escapeMarkdown,
  fenced,
  lineRange,
  presetInstruction,
  PROMPT_PRESETS,
  type ReviewComment,
  reviewPrompt,
} from './prompt-model';

const comment = (over: Partial<ReviewComment>): ReviewComment => ({
  id: 'c',
  path: 'src/a.ts',
  startLine: 3,
  endLine: 3,
  code: 'const x = 1;',
  languageId: 'typescript',
  text: 'Rename x.',
  createdAt: 0,
  ...over,
});

describe('prompt model', () => {
  it('describes line ranges', () => {
    expect(lineRange(4, 4)).toBe('line 4');
    expect(lineRange(4, 9)).toBe('lines 4–9');
  });

  it('fences code with a fence longer than any backtick run inside it', () => {
    expect(fenced('a\n', 'typescript')).toBe('```typescript\na\n```');
    expect(fenced('x = ```y```', 'plaintext')).toBe('````\nx = ```y```\n````');
  });

  it('builds a prompt from an instruction and selections', () => {
    const prompt = buildPrompt('Fix it.', [
      {
        kind: 'code',
        code: { path: 'src/a.ts', startLine: 2, endLine: 3, code: 'a();\nb();', languageId: 'typescript' },
      },
    ]);
    expect(prompt).toBe('Fix it.\n\n`src/a.ts`, lines 2–3:\n\n```typescript\na();\nb();\n```');
  });

  it('points agents at git for a file’s changes and picks the matching preset wording', () => {
    const contexts = [{ kind: 'changes' as const, changes: { path: 'src/a.ts' } }];
    expect(buildPrompt('Review.', contexts)).toBe(
      'Review.\n\nThe uncommitted changes in `src/a.ts` (see `git diff HEAD -- src/a.ts`).',
    );
    const review = PROMPT_PRESETS.find((p) => p.id === 'review')!;
    expect(presetInstruction(review, contexts)).toBe(review.changes);
    expect(presetInstruction(review, [])).toBe(review.code);
    expect(buildPrompt('Explain.', [{ kind: 'file', path: 'a.md' }])).toBe('Explain.\n\nThe file `a.md`.');
  });

  it('turns review comments into one prompt, ordered by file and line', () => {
    const prompt = reviewPrompt([
      comment({ id: '2', path: 'src/b.ts', startLine: 1, endLine: 2, text: 'Why?' }),
      comment({ id: '1', original: true }),
    ]);
    expect(prompt.split('\n\n')[0]).toMatch(/^Please address these 2 review comments/);
    expect(prompt).toContain(
      '1. `src/a.ts`, line 3 (the committed version, HEAD)\n\n```typescript\nconst x = 1;\n```\n\nRename x.',
    );
    expect(prompt).toContain('2. `src/b.ts`, lines 1–2');
    expect(prompt.indexOf('src/a.ts')).toBeLessThan(prompt.indexOf('src/b.ts'));
    expect(reviewPrompt([comment({ code: '' })])).toMatch(
      /this review comment[\s\S]*1\. `src\/a.ts`, line 3\n\nRename x\.$/,
    );
  });

  it('escapes Markdown in comments shown in hovers', () => {
    expect(escapeMarkdown('[x](http://e.vil) **b** <img>')).toBe('\\[x\\]\\(http://e\\.vil\\) \\*\\*b\\*\\* \\<img\\>');
  });
});
