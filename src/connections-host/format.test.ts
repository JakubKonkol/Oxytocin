import { describe, expect, it } from 'vitest';
import { formatCell, formatResult, maskRows, maskValue, scrub } from './format';

describe('formatCell', () => {
  it('formats values for agents', () => {
    expect(formatCell(null)).toBe('NULL');
    expect(formatCell(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(formatCell(Buffer.alloc(1024))).toBe('<binary 1,024 bytes>');
    expect(formatCell(10n ** 20n)).toBe('100000000000000000000');
    expect(formatCell({ a: 1 })).toBe('{"a":1}');
    expect(formatCell('x'.repeat(2500))).toMatch(/^x{2000}… \(500 more characters\)$/);
  });
});

describe('masking', () => {
  it('masks columns and nested fields by glob', () => {
    const r = maskRows(
      {
        columns: [{ name: 'id' }, { name: 'password_hash' }, { name: 'profile' }],
        rows: [
          [1, 'abc', { name: 'a', apiToken: 't', nested: [{ secret: 's' }] }],
          [2, null, null],
        ],
        total: 2,
      },
      ['*password*', '*token*', '*secret*', '*hash*'],
    );
    expect(r.rows).toEqual([
      [1, '***', { name: 'a', apiToken: '***', nested: [{ secret: '***' }] }],
      [2, null, null],
    ]);
    expect(maskValue({ Password: 'x' }, ['*password*'])).toEqual({ Password: '***' });
  });
});

describe('formatResult', () => {
  const result = {
    columns: [{ name: 'id', type: 'int4' }, { name: 'note' }],
    rows: [
      [1, 'a|b'],
      [2, 'line\nbreak'],
      [3, 'c'],
    ],
    total: 5312,
  };

  it('writes a Markdown table with counts and a hint when rows were cut', () => {
    const text = formatResult(result, { format: 'markdown', maxRows: 2, maxBytes: 256 * 1024 });
    expect(text).toContain('Columns: id (int4), note');
    expect(text).toContain('2 of 5,312 rows shown — add a WHERE or LIMIT.');
    expect(text).toContain('| 1 | a\\|b |');
    expect(text).toContain('| 2 | line\\nbreak |');
    expect(text).not.toContain('| 3 |');
  });

  it('says "more than" when the total is unknown', () => {
    const text = formatResult({ ...result, total: null }, { format: 'markdown', maxRows: 2, maxBytes: 65536 });
    expect(text).toContain('2 of more than 2 rows shown');
  });

  it('writes JSON on request', () => {
    const text = formatResult({ ...result, total: 3 }, { format: 'json', maxRows: 10, maxBytes: 65536 });
    expect(text).toContain('3 rows.');
    expect(text).toContain('{"id":1,"note":"a|b"}');
  });

  it('respects the byte limit', () => {
    const big = { columns: [{ name: 'v' }], rows: Array.from({ length: 100 }, () => ['x'.repeat(1000)]), total: 100 };
    const text = formatResult(big, { format: 'markdown', maxRows: 100, maxBytes: 8 * 1024 });
    expect(text.length).toBeLessThan(9 * 1024);
    expect(text).toMatch(/of 100 rows shown \(the 8 KB result limit\)/);
  });

  it('reports writes', () => {
    expect(
      formatResult(
        { columns: [], rows: [], total: 0, affected: 3, command: 'UPDATE 3' },
        { format: 'markdown', maxRows: 1, maxBytes: 4096 },
      ),
    ).toBe('UPDATE 3\n3 rows affected.');
  });
});

describe('scrub', () => {
  it('removes secrets, URL credentials and connection string passwords', () => {
    expect(scrub('password authentication failed for "s3cr3t!"', ['s3cr3t!'])).toBe(
      'password authentication failed for "***"',
    );
    expect(scrub('connect postgres://bob:p%40ss@db:5432/x failed', [])).toBe(
      'connect postgres://bob:***@db:5432/x failed',
    );
    expect(scrub('Server=x;Password=hunter2;User Id=sa', [])).toBe('Server=x;Password=***;User Id=sa');
    expect(scrub('encoded p%40ss here', ['p@ss'])).toBe('encoded *** here');
    expect(scrub('short ab', ['ab'])).toBe('short ab');
  });
});
