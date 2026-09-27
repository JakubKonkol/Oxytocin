import { describe, expect, it } from 'vitest';
import { formatWhen, parseWhen, resolveUserKeybindings } from './keybindings';

describe('parseWhen', () => {
  it('parses single contexts, alternatives and negations', () => {
    expect(parseWhen(undefined)).toEqual({});
    expect(parseWhen('terminalFocus')).toEqual({ when: ['terminalFocus'] });
    expect(parseWhen('diffFocus || changesFocus')).toEqual({ when: ['diffFocus', 'changesFocus'] });
    expect(parseWhen('!terminalFocus')).toEqual({ notWhen: ['terminalFocus'] });
    expect(parseWhen('!terminalFocus && !inputFocus')).toEqual({ notWhen: ['terminalFocus', 'inputFocus'] });
  });

  it('rejects unknown contexts and impossible combinations', () => {
    const error = (e: string) => {
      const r = parseWhen(e);
      return 'error' in r ? r.error : null;
    };
    expect(error('editorFocus')).toContain('Unknown context');
    expect(error('terminalFocus && diffFocus')).toBeTruthy();
    expect(error('!terminalFocus || diffFocus')).toBeTruthy();
    expect(error('a || b && c')).toBeTruthy();
  });

  it('round-trips through formatWhen', () => {
    for (const e of ['terminalFocus', 'diffFocus || changesFocus', '!terminalFocus && !inputFocus']) {
      const parsed = parseWhen(e);
      expect('error' in parsed).toBe(false);
      expect(formatWhen(parsed as never)).toBe(e);
    }
  });
});

describe('resolveUserKeybindings', () => {
  it('requires an array and a key for non-removals', () => {
    expect(resolveUserKeybindings({}).problems[0]!.index).toBe(-1);
    const r = resolveUserKeybindings([{ command: 'a' }, { command: '-a' }, { key: 'F2', command: 'b', args: [1] }, 3]);
    expect(r.entries).toEqual([{ command: '-a' }, { key: 'F2', command: 'b', args: [1] }]);
    expect(r.problems.map((p) => p.index)).toEqual([0, 3]);
  });
});
