import type { SqlParsers } from './sql-guard';

const DATABASE = { mysql: 'mysql', mariadb: 'mariadb', sqlserver: 'transactsql', sqlite: 'sqlite' } as const;

let ready: Promise<SqlParsers> | undefined;

/** A CommonJS module's export under any loader (named export, or on `default` when a loader wraps it). */
function exportOf<T>(module: unknown, name: string): T {
  const m = module as Record<string, unknown> & { default?: Record<string, unknown> };
  const value = m[name] ?? m.default?.[name];
  if (value === undefined) throw new Error(`The SQL parser module has no export ${name}`);
  return value as T;
}

type ParserClass = new () => { parse(sql: string, opt: { database: string }): { ast: unknown; tableList: string[] } };

/**
 * The SQL parsers: PostgreSQL's own parser (libpg-query, WebAssembly) and node-sql-parser's per-dialect builds (the
 * full package bundles every dialect). Loaded once, on the first query that needs them.
 */
export function loadSqlParsers(): Promise<SqlParsers> {
  ready ??= (async () => {
    const [pg, mysql, mariadb, tsql, sqlite] = await Promise.all([
      import('libpg-query'),
      import('node-sql-parser/build/mysql'),
      import('node-sql-parser/build/mariadb'),
      import('node-sql-parser/build/transactsql'),
      import('node-sql-parser/build/sqlite'),
    ]);
    await exportOf<() => Promise<void>>(pg, 'loadModule')();
    const parseSync = exportOf<(text: string) => unknown>(pg, 'parseSync');
    const parser = (m: unknown) => new (exportOf<ParserClass>(m, 'Parser'))();
    const generic = { mysql: parser(mysql), mariadb: parser(mariadb), sqlserver: parser(tsql), sqlite: parser(sqlite) };
    return {
      postgresql: (text) => parseSync(text),
      generic: (dialect, text) => {
        const result = generic[dialect].parse(text, { database: DATABASE[dialect] });
        return { ast: result.ast, tableList: result.tableList };
      },
    } satisfies SqlParsers;
  })().catch((e: unknown) => {
    ready = undefined;
    throw e;
  });
  return ready;
}
