import { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { Terminal } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';
import { terminalText } from './terminal-registry';

const write = (term: HeadlessTerminal, data: string) => new Promise<void>((resolve) => term.write(data, resolve));

describe('terminalText', () => {
  it('joins rows soft-wrapped at the terminal width and keeps hard line breaks', async () => {
    const term = new HeadlessTerminal({ cols: 10, rows: 5, allowProposedApi: true });
    await write(term, '$ echo 0123456789abc\r\nfirst\r\n\r\nsec  nd line   \r\n');
    expect(terminalText(term as unknown as Terminal)).toBe('$ echo 0123456789abc\nfirst\n\nsec  nd line');
    term.dispose();
  });

  it('keeps spaces at the wrap boundary', async () => {
    const term = new HeadlessTerminal({ cols: 5, rows: 3, allowProposedApi: true });
    await write(term, 'abcd efgh');
    expect(terminalText(term as unknown as Terminal)).toBe('abcd efgh');
    term.dispose();
  });
});
