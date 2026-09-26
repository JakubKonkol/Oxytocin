import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations';

export type Database = DatabaseSync;

/** Runs `fn` in a transaction (rolled back when it throws). */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function schemaVersion(db: Database): number {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

/** Applies pending migrations, each in its own transaction; returns the resulting schema version. */
export function migrate(db: Database, migrations = MIGRATIONS): number {
  let version = schemaVersion(db);
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= version) continue;
    transaction(db, () => {
      db.exec(m.sql);
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(m.version));
    });
    version = m.version;
  }
  return version;
}

export function getMeta(db: Database, key: string): string | undefined {
  return (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}

/** Opens (and migrates) the usage database; `:memory:` for tests. Only the ingest worker opens it. */
export function openDatabase(path: string): Database {
  const db = new DatabaseSync(path);
  db.exec(
    'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;',
  );
  migrate(db);
  return db;
}
