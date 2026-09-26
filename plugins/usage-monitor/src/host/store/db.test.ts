import { describe, expect, it } from 'vitest';
import { getMeta, migrate, openDatabase, schemaVersion, setMeta, transaction } from './db';

describe('usage database', () => {
  it('applies migrations once and records the schema version', () => {
    const db = openDatabase(':memory:');
    expect(schemaVersion(db)).toBe(1);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(tables).toEqual([
      'agent_limits',
      'budget_alerts',
      'budgets',
      'ingest_cursors',
      'meta',
      'sessions',
      'usage_events',
    ]);
    expect(migrate(db)).toBe(1);
    expect(migrate(db, [{ version: 2, name: 'extra', sql: 'CREATE TABLE extra (x INTEGER);' }])).toBe(2);
    db.close();
  });

  it('rolls back a failed transaction and a failed migration', () => {
    const db = openDatabase(':memory:');
    setMeta(db, 'k', 'a');
    expect(() =>
      transaction(db, () => {
        setMeta(db, 'k', 'b');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(getMeta(db, 'k')).toBe('a');
    expect(() => migrate(db, [{ version: 5, name: 'bad', sql: 'CREATE TABLE ok (x); NOT SQL;' }])).toThrow();
    expect(schemaVersion(db)).toBe(1);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'ok'").get()).toEqual({ n: 0 });
    db.close();
  });
});
