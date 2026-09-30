import type { ResultSet } from '../format';

export interface QueryOptions {
  /** Rows to return at most (the driver fetches one more to know that there are more). */
  maxRows: number;
  timeoutMs: number;
  /** Run in a read-only transaction (rolled back), or in a transaction committed after success. */
  write: boolean;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable?: boolean;
  default?: string | null;
}

export interface TableInfo {
  schema?: string;
  name: string;
  /** table, view, materialized view, collection… */
  type: string;
  rows?: number;
  columns?: ColumnInfo[];
  primaryKey?: string[];
  foreignKeys?: { columns: string[]; references: string }[];
  indexes?: { name: string; definition: string }[];
  comment?: string;
}

export interface SchemaRequest {
  schema?: string;
  table?: string;
  timeoutMs: number;
}

export interface SqlDriver {
  readonly family: 'sql';
  /** "PostgreSQL 17.2" (also checks the connection). */
  version(timeoutMs: number): Promise<string>;
  query(sql: string, params: unknown[], o: QueryOptions): Promise<ResultSet>;
  /** Tables (and their columns when a schema or table is given). */
  schema(r: SchemaRequest): Promise<TableInfo[]>;
  close(): Promise<void>;
}

export interface MongoDriver {
  readonly family: 'mongodb';
  version(timeoutMs: number): Promise<string>;
  run(
    collection: string,
    operation: string,
    args: Record<string, unknown>,
    o: { maxRows: number; timeoutMs: number },
  ): Promise<{ documents?: unknown[]; value?: unknown; more?: boolean; total?: number | null }>;
  schema(r: { collection?: string; timeoutMs: number; masking: readonly string[] }): Promise<string>;
  close(): Promise<void>;
}

export interface RedisDriver {
  readonly family: 'redis';
  version(timeoutMs: number): Promise<string>;
  call(command: string, args: string[], timeoutMs: number): Promise<unknown>;
  schema(timeoutMs: number): Promise<string>;
  close(): Promise<void>;
}

export type Driver = SqlDriver | MongoDriver | RedisDriver;

/** Removes trailing semicolons (Oracle and cursors reject them; the guard already allows only one statement). */
export const stripTrailingSemicolons = (sql: string): string => sql.replace(/[\s;]+$/, '');

const n = (x: number) => x.toLocaleString('en-US');

/** The schema as compact text for agents. */
export function renderSchema(tables: TableInfo[], r: { schema?: string; table?: string }, limit = 400): string {
  if (tables.length === 0) {
    if (r.table)
      return `No table or view "${r.table}"${r.schema ? ` in ${r.schema}` : ''}. Call oxy_db_schema without \`table\` to list them.`;
    return r.schema ? `No tables or views in ${r.schema}.` : 'No tables or views.';
  }
  const qualified = (t: TableInfo) => (t.schema ? `${t.schema}.${t.name}` : t.name);
  if (r.table) {
    return tables
      .map((t) => {
        const lines = [
          `${qualified(t)} (${t.type}${t.rows !== undefined && t.rows >= 0 ? `, ~${n(t.rows)} rows` : ''})`,
        ];
        if (t.comment) lines.push(`  -- ${t.comment}`);
        for (const c of t.columns ?? [])
          lines.push(
            `  ${c.name} ${c.type}${c.nullable === false ? ' NOT NULL' : ''}${c.default ? ` DEFAULT ${c.default}` : ''}`,
          );
        if (t.primaryKey?.length) lines.push(`  PRIMARY KEY (${t.primaryKey.join(', ')})`);
        for (const fk of t.foreignKeys ?? [])
          lines.push(`  FOREIGN KEY (${fk.columns.join(', ')}) REFERENCES ${fk.references}`);
        for (const ix of t.indexes ?? []) lines.push(`  INDEX ${ix.name}: ${ix.definition}`);
        return lines.join('\n');
      })
      .join('\n\n');
  }
  const shown = tables.slice(0, limit);
  const body = shown.map((t) => {
    const cols = t.columns?.length ? `(${t.columns.map((c) => `${c.name} ${c.type}`).join(', ')})` : '';
    const rows = t.rows !== undefined && t.rows >= 0 ? ` ~${n(t.rows)} rows` : '';
    return `- ${qualified(t)} [${t.type}${rows}]${cols ? ` ${cols}` : ''}`;
  });
  const more = tables.length > limit ? `\n… and ${n(tables.length - limit)} more; pass \`schema\` or \`table\`.` : '';
  const hint = r.schema
    ? ''
    : '\nPass `table` for the columns, keys and indexes of one table, or `schema` for all columns of a schema.';
  return `${body.join('\n')}${more}${hint}`;
}
