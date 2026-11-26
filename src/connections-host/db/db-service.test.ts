import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseResourceSchema } from '@shared/domain/project-resources';
import type { DbQueryRequest, GuardOutcome } from '@shared/rpc/contracts/connections-host';
import { DbService, maskRedis, renderRedis } from './db-service';

const textOf = (r: GuardOutcome) => (r.status === 'done' ? r.text : `${r.status}: ${r.message}`);
const savedPath = (text: string) => /to (\.oxy\/results\/\S+\.json)/.exec(text)?.[1];

describe('DbService results too large for the reply (SQLite)', () => {
  let root: string;
  const service = new DbService();

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'oxy-db-'));
    const db = new DatabaseSync(join(root, 'app.db'));
    db.exec('CREATE TABLE docs (id INTEGER PRIMARY KEY, body TEXT, api_token TEXT)');
    const insert = db.prepare('INSERT INTO docs (body, api_token) VALUES (?, ?)');
    for (let i = 1; i <= 25; i++) insert.run(i === 1 ? `start-${'x'.repeat(5000)}-end` : `doc ${i}`, `t${i}`);
    db.close();
  });
  afterAll(() => service.dispose());

  const request = (o: Partial<DbQueryRequest> & { access?: Record<string, unknown> } = {}): DbQueryRequest => {
    const { access, ...rest } = o;
    return {
      key: 'p/db',
      fingerprint: 'v1',
      projectRoot: root,
      secrets: {},
      resource: DatabaseResourceSchema.parse({
        id: 'db',
        name: 'app-db',
        engine: 'sqlite',
        connection: { kind: 'file', path: 'app.db' },
        ...(access ? { access } : {}),
      }),
      query: 'SELECT * FROM docs ORDER BY id',
      ...rest,
    };
  };

  it('cuts long values as before when there is nowhere to save', async () => {
    const text = textOf(await service.query(request()));
    expect(text).toContain('25 rows.');
    expect(text).toContain('more characters)');
    expect(text).not.toContain('-end');
  });

  it('saves every row with full values when a value is cut, masked like the reply', async () => {
    const text = textOf(await service.query(request({ resultsRoot: root })));
    expect(text).toMatch(/^The 25 rows \(a JSON array, one row per line\) saved in full/);
    expect(text).toContain('Preview:');
    const rows = JSON.parse(await readFile(join(root, savedPath(text)!), 'utf8')) as Record<string, unknown>[];
    expect(rows).toHaveLength(25);
    expect(rows[0]!['body']).toBe(`start-${'x'.repeat(5000)}-end`);
    expect(rows[0]!['api_token']).toBe('***');
  });

  it('saves the rows left out for the reply size, and up to the file limit when asked', async () => {
    const small = textOf(
      await service.query(
        request({
          resultsRoot: root,
          query: 'SELECT id, body FROM docs WHERE id > 1',
          access: { maxResultBytes: 4096 },
        }),
      ),
    );
    expect(small).not.toContain('saved in full');
    const limited = textOf(
      await service.query(request({ resultsRoot: root, query: 'SELECT id FROM docs', access: { maxRows: 5 } })),
    );
    expect(limited).toContain('5 of 25 rows shown');
    expect(limited).toContain('Pass saveToFile: true to save up to 100,000 rows to a file.');
    const asked = textOf(
      await service.query(
        request({ resultsRoot: root, query: 'SELECT id FROM docs', access: { maxRows: 5 }, saveToFile: true }),
      ),
    );
    expect(asked).toMatch(/^The 25 rows/);
    const rows = JSON.parse(await readFile(join(root, savedPath(asked)!), 'utf8')) as unknown[];
    expect(rows).toHaveLength(25);
    const capped = textOf(
      await service.query(
        request({
          resultsRoot: root,
          query: 'SELECT id FROM docs',
          access: { maxRows: 5, maxFileRows: 10 },
          saveToFile: true,
        }),
      ),
    );
    expect(capped).toMatch(/^The 10 rows/);
    expect(capped).toContain('more rows than the 10 rows saved');
  });
});

describe('DbService when a result cannot be saved', () => {
  it('shows what fits with a note', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oxy-db-'));
    const db = new DatabaseSync(join(root, 'app.db'));
    db.exec(`CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('${'y'.repeat(3000)}')`);
    db.close();
    const service = new DbService();
    try {
      const r = await service.query({
        key: 'p/db2',
        fingerprint: 'v1',
        projectRoot: root,
        secrets: {},
        resource: DatabaseResourceSchema.parse({
          id: 'db2',
          name: 'db2',
          engine: 'sqlite',
          connection: { kind: 'file', path: 'app.db' },
        }),
        query: 'SELECT v FROM t',
        resultsRoot: join(root, 'missing'),
      });
      const text = textOf(r);
      expect(text).toContain('1 row.');
      expect(text).toContain('The full result could not be saved to .oxy/results');
    } finally {
      await service.dispose();
    }
  });
});

describe('Redis replies', () => {
  it('tells when a reply was cut and masks hash fields in the saved value', () => {
    expect(renderRedis('GET', ['k'], 'short', [], 4096)).toEqual({ text: '"short"', complete: true });
    expect(renderRedis('GET', ['k'], 'x'.repeat(3000), [], 64 * 1024).complete).toBe(false);
    expect(
      renderRedis(
        'LRANGE',
        ['l'],
        Array.from({ length: 500 }, (_, i) => `item ${i}`),
        [],
        2048,
      ).complete,
    ).toBe(false);
    expect(maskRedis('HGETALL', ['user:1'], ['name', 'a', 'api_token', 't'], ['*token*'])).toEqual([
      'name',
      'a',
      'api_token',
      '***',
    ]);
    expect(maskRedis('GET', ['session_token'], 'abc', ['*token*'])).toBe('***');
    expect(maskRedis('TTL', ['session_token'], 42, ['*token*'])).toBe(42);
  });
});
