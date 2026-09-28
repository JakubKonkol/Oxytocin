import { describe, expect, it } from 'vitest';
import { applyChange, codeBlock, continueList, type TextChange, toggleInline, toggleLinePrefix } from './format';

/** Applies a change and marks the new selection with [ ]. */
function show(text: string, change: TextChange | null): string {
  if (!change) return 'null';
  const out = applyChange(text, change);
  return `${out.slice(0, change.selStart)}[${out.slice(change.selStart, change.selEnd)}]${out.slice(change.selEnd)}`;
}

describe('scratchpad formatting', () => {
  it('wraps and unwraps inline markers', () => {
    expect(show('make it bold', toggleInline('make it bold', 8, 12, 'bold'))).toBe('make it **[bold]**');
    expect(show('make it **bold**', toggleInline('make it **bold**', 10, 14, 'bold'))).toBe('make it [bold]');
    expect(show('make it **bold**', toggleInline('make it **bold**', 8, 16, 'bold'))).toBe('make it [bold]');
    expect(show('x', toggleInline('x', 1, 1, 'italic'))).toBe('x_[]_');
    expect(show('run npm test', toggleInline('run npm test', 4, 12, 'code'))).toBe('run `[npm test]`');
    expect(show('old', toggleInline('old', 0, 3, 'strike'))).toBe('~~[old]~~');
  });

  it('toggles line prefixes on every selected line', () => {
    const text = 'one\ntwo\nthree';
    expect(show(text, toggleLinePrefix(text, 0, text.length, 'bullet'))).toBe('[- one\n- two\n- three]');
    expect(show(text, toggleLinePrefix(text, 0, text.length, 'numbered'))).toBe('[1. one\n2. two\n3. three]');
    const bullets = '- one\n- two';
    expect(show(bullets, toggleLinePrefix(bullets, 0, bullets.length, 'bullet'))).toBe('[one\ntwo]');
    // Another list type replaces the prefix.
    expect(show(bullets, toggleLinePrefix(bullets, 0, bullets.length, 'task'))).toBe('[- [ ] one\n- [ ] two]');
    // One line: the caret stays on the same text.
    expect(show('title', toggleLinePrefix('title', 2, 2, 'heading'))).toBe('## ti[]tle');
    expect(show('> quoted', toggleLinePrefix('> quoted', 4, 4, 'quote'))).toBe('qu[]oted');
    // An empty line gets the prefix.
    expect(show('', toggleLinePrefix('', 0, 0, 'bullet'))).toBe('- []');
    // Only the caret's line changes.
    expect(show('a\nb\nc', toggleLinePrefix('a\nb\nc', 2, 2, 'bullet'))).toBe('a\n- []b\nc');
  });

  it('puts the selected lines in a code block', () => {
    expect(show('see:\nls -la', codeBlock('see:\nls -la', 5, 11))).toBe('see:\n```\n[ls -la]\n```');
    expect(show('', codeBlock('', 0, 0))).toBe('```\n[]\n```');
  });

  it('continues and ends lists on Enter', () => {
    expect(show('- first', continueList('- first', 7))).toBe('- first\n- []');
    expect(show('  3. third', continueList('  3. third', 10))).toBe('  3. third\n  4. []');
    expect(show('- [x] done', continueList('- [x] done', 10))).toBe('- [x] done\n- [ ] []');
    expect(show('> quote', continueList('> quote', 7))).toBe('> quote\n> []');
    // An empty item ends the list.
    expect(show('- a\n- ', continueList('- a\n- ', 6))).toBe('- a\n[]');
    // Not a list, or the caret inside the marker: a plain newline.
    expect(continueList('plain', 5)).toBeNull();
    expect(continueList('- item', 1)).toBeNull();
  });
});
