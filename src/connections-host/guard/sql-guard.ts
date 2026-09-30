import type { AccessMode, SqlDialect } from '@shared/domain/project-resources';
import type { Classification } from '@shared/rpc/contracts/connections-host';
import { deniedReason, isBuiltinFunction, NOT_FUNCTIONS } from './functions';
import { functionCalls, hasSequence, SqlLexError, splitStatements, type Token, tokenize } from './sql-lexer';
import { scalarText } from '@shared/utils/text';

/** Real parsers per dialect (PostgreSQL's own parser, node-sql-parser for the others); injected for tests. */
export interface SqlParsers {
  /** libpg-query `parseSync`: `{ stmts: [{ stmt: { SelectStmt: … } }] }`. */
  postgresql(text: string): unknown;
  /** node-sql-parser `parse`: `{ ast, tableList }`. */
  generic(dialect: 'mysql' | 'mariadb' | 'sqlserver' | 'sqlite', text: string): { ast: unknown; tableList: string[] };
}

export interface GuardOptions {
  allowUserFunctions: boolean;
}

const unknown = (statement: string, reason: string): Classification => ({
  kind: 'unknown',
  statement,
  tables: [],
  reasons: [reason],
  dangerous: [],
});

const SIMPLIFY =
  'Send exactly one statement in a syntax the guard understands (plain SELECT/WITH … SELECT/SHOW/EXPLAIN for reads); simplify the query or split it into several calls.';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Visits every `{ NodeType: {...} }` object of a libpg-query tree. */
function walkPg(node: unknown, visit: (type: string, body: Json) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walkPg(item, visit);
    return;
  }
  if (!isObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (/^[A-Z]/.test(key) && isObject(value)) visit(key, value);
    // INSERT/UPDATE/DELETE targets are bare RangeVar bodies.
    else if (key === 'relation' && isObject(value) && typeof value['relname'] === 'string') visit('RangeVar', value);
    walkPg(value, visit);
  }
}

const PG_DDL = new Set([
  'TruncateStmt',
  'RenameStmt',
  'CommentStmt',
  'IndexStmt',
  'ViewStmt',
  'RuleStmt',
  'DefineStmt',
  'CompositeTypeStmt',
  'SecLabelStmt',
  'AlterObjectSchemaStmt',
  'AlterOwnerStmt',
  'CreatedbStmt',
  'DropdbStmt',
]);
const PG_DCL = new Set([
  'GrantStmt',
  'GrantRoleStmt',
  'CreateRoleStmt',
  'AlterRoleStmt',
  'AlterRoleSetStmt',
  'DropRoleStmt',
  'ReassignOwnedStmt',
  'DropOwnedStmt',
  'AlterDefaultPrivilegesStmt',
  'AlterPolicyStmt',
  'CreatePolicyStmt',
]);
const PG_WRITES = new Set(['InsertStmt', 'UpdateStmt', 'DeleteStmt', 'MergeStmt']);

const statementName = (type: string) =>
  type
    .replace(/Stmt$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toUpperCase();

function checkFunctions(
  c: Classification,
  dialect: SqlDialect,
  calls: { name: string; qualifier?: string }[],
  opts: GuardOptions,
): void {
  const seen = new Set<string>();
  for (const { name, qualifier } of calls) {
    const label = qualifier ? `${qualifier}.${name}` : name;
    if (seen.has(label)) continue;
    seen.add(label);
    const denied = deniedReason(dialect, name, qualifier);
    if (denied) {
      const reason = `${label}() ${denied}`;
      c.reasons.push(reason);
      c.dangerous.push(reason);
    } else if (!opts.allowUserFunctions && !isBuiltinFunction(dialect, name, qualifier)) {
      c.reasons.push(
        `${label}() is not a built-in function; the bridge cannot tell whether it writes (the user can allow user-defined functions for this database)`,
      );
    }
  }
}

function classifyPostgres(text: string, tokens: Token[], parsers: SqlParsers, opts: GuardOptions): Classification {
  let tree: unknown;
  try {
    tree = parsers.postgresql(text);
  } catch (e) {
    return unknown(
      '?',
      `The statement could not be parsed (${e instanceof Error ? e.message : String(e)}). ${SIMPLIFY}`,
    );
  }
  const stmts = isObject(tree) && Array.isArray(tree['stmts']) ? tree['stmts'] : [];
  if (stmts.length !== 1) return unknown('?', `${stmts.length || 'No'} statements found. ${SIMPLIFY}`);
  const root = isObject(stmts[0]) ? stmts[0]['stmt'] : undefined;
  if (!isObject(root)) return unknown('?', SIMPLIFY);
  const [type, body] = Object.entries(root)[0] as [string, Json];
  const c: Classification = { kind: 'read', statement: statementName(type), tables: [], reasons: [], dangerous: [] };

  let explainOnly = false;
  if (type === 'SelectStmt') c.statement = body['valuesLists'] ? 'VALUES' : 'SELECT';
  else if (type === 'VariableShowStmt') c.statement = 'SHOW';
  else if (type === 'ExplainStmt') {
    explainOnly = true;
    const options = Array.isArray(body['options']) ? body['options'] : [];
    const analyze = options.some((o) => {
      const def = isObject(o) && isObject(o['DefElem']) ? o['DefElem'] : undefined;
      if (!def || def['defname'] !== 'analyze') return false;
      const arg = isObject(def['arg']) && isObject(def['arg']['String']) ? def['arg']['String']['sval'] : undefined;
      return !(typeof arg === 'string' && /^(false|off|0)$/i.test(arg));
    });
    if (analyze) {
      explainOnly = false;
      c.statement = 'EXPLAIN ANALYZE';
      c.reasons.push('EXPLAIN ANALYZE runs the statement');
      const inner = isObject(body['query']) ? Object.keys(body['query'])[0] : undefined;
      if (inner && inner !== 'SelectStmt') c.kind = 'write';
    }
  } else if (PG_WRITES.has(type)) c.kind = 'write';
  else if (type === 'CopyStmt') {
    c.kind = 'write';
    c.reasons.push('COPY reads or writes files');
  } else if (PG_DCL.has(type)) c.kind = 'dcl';
  else if (PG_DDL.has(type) || /^(Create|Alter|Drop)/.test(type)) c.kind = 'ddl';
  else c.kind = 'write';
  if (c.kind !== 'read') c.reasons.push(`${c.statement} is not a read`);

  const cteNames = new Set<string>();
  const tables = new Set<string>();
  const calls: { name: string; qualifier?: string }[] = [];
  walkPg(root, (node, value) => {
    if (node === 'CommonTableExpr' && typeof value['ctename'] === 'string') cteNames.add(value['ctename']);
    if (node === 'RangeVar' && typeof value['relname'] === 'string')
      tables.add(
        typeof value['schemaname'] === 'string' ? `${value['schemaname']}.${value['relname']}` : value['relname'],
      );
    // A plain EXPLAIN only plans the statement.
    if (explainOnly) return;
    if (PG_WRITES.has(node) && node !== type && c.kind === 'read') {
      c.kind = 'write';
      c.reasons.push(`contains ${statementName(node)} (a data-modifying WITH clause)`);
    }
    if ((node === 'UpdateStmt' || node === 'DeleteStmt') && !value['whereClause'])
      c.dangerous.push(`${statementName(node)} without WHERE changes every row`);
    if (node === 'SelectStmt' && value['intoClause']) {
      c.reasons.push('SELECT … INTO creates a table');
      if (c.kind === 'read') c.kind = 'ddl';
    }
    if (node === 'SelectStmt' && value['lockingClause']) c.reasons.push('FOR UPDATE / FOR SHARE locks rows');
    if (node === 'FuncCall' && Array.isArray(value['funcname'])) {
      const parts = value['funcname']
        .map((p) => (isObject(p) && isObject(p['String']) ? p['String']['sval'] : undefined))
        .filter((s): s is string => typeof s === 'string');
      const name = parts.at(-1);
      if (name) calls.push({ name, ...(parts.length > 1 ? { qualifier: parts.at(-2)! } : {}) });
    }
  });
  if (type === 'DropStmt') c.dangerous.push('DROP removes objects and their data');
  if (type === 'TruncateStmt') c.dangerous.push('TRUNCATE removes every row');
  if (type === 'AlterTableStmt' && JSON.stringify(body).includes('"AT_Drop'))
    c.dangerous.push('ALTER … DROP removes a column or constraint');
  if (type === 'DropStmt' && Array.isArray(body['objects'])) {
    for (const o of body['objects']) {
      const items = isObject(o) && isObject(o['List']) && Array.isArray(o['List']['items']) ? o['List']['items'] : [];
      const name = items
        .map((p) => (isObject(p) && isObject(p['String']) ? p['String']['sval'] : ''))
        .filter(Boolean)
        .join('.');
      if (name) tables.add(name);
    }
  }
  c.tables = [...tables].filter((t) => !cteNames.has(t));
  if (type === 'CallStmt') c.dangerous.push('CALL runs a procedure');
  checkFunctions(c, 'postgresql', calls, opts);
  lexerChecks(c, tokens, 'postgresql');
  return c;
}

const GENERIC_KIND: Record<string, Classification['kind']> = {
  select: 'read',
  show: 'read',
  desc: 'read',
  describe: 'read',
  explain: 'read',
  insert: 'write',
  replace: 'write',
  update: 'write',
  delete: 'write',
  create: 'ddl',
  alter: 'ddl',
  drop: 'ddl',
  truncate: 'ddl',
  rename: 'ddl',
  grant: 'dcl',
  revoke: 'dcl',
};

/** Visits every object of a node-sql-parser AST. */
function walkGeneric(node: unknown, visit: (value: Json) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walkGeneric(item, visit);
    return;
  }
  if (!isObject(node)) return;
  visit(node);
  for (const value of Object.values(node)) walkGeneric(value, visit);
}

function genericFunctionName(node: Json): { name: string; qualifier?: string } | undefined {
  if (node['type'] === 'aggr_func' && typeof node['name'] === 'string') return { name: node['name'] };
  if (node['type'] !== 'function') return undefined;
  const name = node['name'];
  if (typeof name === 'string') return { name };
  if (!isObject(name)) return undefined;
  const parts = Array.isArray(name['name'])
    ? name['name'].map((p) => (isObject(p) ? p['value'] : undefined)).filter((s): s is string => typeof s === 'string')
    : [];
  const last = parts.at(-1);
  if (!last) return undefined;
  const schema = isObject(name['schema']) ? name['schema']['value'] : undefined;
  const qualifier = parts.length > 1 ? parts.at(-2) : typeof schema === 'string' ? schema : undefined;
  return { name: last, ...(qualifier ? { qualifier } : {}) };
}

function classifyGeneric(
  dialect: 'mysql' | 'mariadb' | 'sqlserver' | 'sqlite',
  text: string,
  tokens: Token[],
  parsers: SqlParsers,
  opts: GuardOptions,
): Classification {
  let parsed: { ast: unknown; tableList: string[] };
  try {
    parsed = parsers.generic(dialect, text);
  } catch (e) {
    const message = e instanceof Error ? e.message.split('\n')[0]!.slice(0, 200) : String(e);
    return unknown('?', `The statement could not be parsed (${message}). ${SIMPLIFY}`);
  }
  const asts = Array.isArray(parsed.ast) ? parsed.ast : [parsed.ast];
  if (asts.length !== 1 || !isObject(asts[0])) return unknown('?', `${asts.length} statements found. ${SIMPLIFY}`);
  const ast = asts[0];
  const type = scalarText(ast['type']).toLowerCase();
  const c: Classification = {
    kind: GENERIC_KIND[type] ?? 'write',
    statement: type === 'desc' ? 'DESCRIBE' : type.toUpperCase() || '?',
    tables: [
      ...new Set(
        parsed.tableList
          .map((entry) => entry.split('::'))
          .map(([, db, table]) => (table && table !== 'null' ? (db && db !== 'null' ? `${db}.${table}` : table) : ''))
          .filter(Boolean),
      ),
    ],
    reasons: [],
    dangerous: [],
  };
  if (type === 'exec') c.statement = 'EXEC';
  if (c.kind !== 'read') c.reasons.push(`${c.statement} is not a read`);
  if (type === 'select') {
    const into = ast['into'];
    if (isObject(into) && (into['expr'] || into['keyword'] || into['type'] === 'into'))
      c.reasons.push('SELECT … INTO writes a table, a file or a variable');
    if (ast['locking_read'] || ast['for_update']) c.reasons.push('the locking clause locks rows');
    const withList = Array.isArray(ast['with']) ? ast['with'] : [];
    for (const cte of withList) {
      const inner = isObject(cte) && isObject(cte['stmt']) ? (cte['stmt']['ast'] ?? cte['stmt']) : undefined;
      const innerType = isObject(inner) ? scalarText(inner['type']) : '';
      if (innerType && innerType !== 'select') {
        c.kind = 'write';
        c.reasons.push(`contains ${innerType.toUpperCase()} in a WITH clause`);
      }
    }
  }
  if (type === 'drop') c.dangerous.push('DROP removes objects and their data');
  if (type === 'truncate') c.dangerous.push('TRUNCATE removes every row');
  if ((type === 'update' || type === 'delete') && !ast['where'])
    c.dangerous.push(`${type.toUpperCase()} without WHERE changes every row`);
  if (type === 'exec' || type === 'call') c.dangerous.push(`${c.statement} runs a procedure`);
  const calls: { name: string; qualifier?: string }[] = [];
  walkGeneric(ast, (node) => {
    if (type === 'alter' && node['action'] === 'drop') c.dangerous.push('ALTER … DROP removes a column or constraint');
    const fn = genericFunctionName(node);
    if (fn) calls.push(fn);
    if (node['type'] === 'select' && node !== ast && isObject(node['into']) && node['into']['expr'])
      c.reasons.push('SELECT … INTO writes a table, a file or a variable');
  });
  c.dangerous = [...new Set(c.dangerous)];
  checkFunctions(c, dialect, calls, opts);
  lexerChecks(c, tokens, dialect);
  return c;
}

const LEXER_READ_STARTS: Partial<Record<SqlDialect, Set<string>>> = {
  oracle: new Set(['SELECT', 'WITH']),
  clickhouse: new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXISTS', 'EXPLAIN']),
};

const WRITE_WORDS: Record<string, Classification['kind']> = {
  INSERT: 'write',
  UPDATE: 'write',
  DELETE: 'write',
  MERGE: 'write',
  UPSERT: 'write',
  CREATE: 'ddl',
  ALTER: 'ddl',
  DROP: 'ddl',
  TRUNCATE: 'ddl',
  RENAME: 'ddl',
  COMMENT: 'ddl',
  GRANT: 'dcl',
  REVOKE: 'dcl',
  EXEC: 'write',
  EXECUTE: 'write',
  CALL: 'write',
  BEGIN: 'write',
  DECLARE: 'write',
  COMMIT: 'write',
  ROLLBACK: 'write',
  OPTIMIZE: 'write',
  SYSTEM: 'write',
  KILL: 'write',
  ATTACH: 'write',
  DETACH: 'write',
  LOCK: 'write',
  EXCHANGE: 'write',
  UNDROP: 'ddl',
};

/** Oracle and ClickHouse: keyword-based (both engines also enforce read-only reads on the server). */
function classifyByTokens(dialect: 'oracle' | 'clickhouse', tokens: Token[], opts: GuardOptions): Classification {
  const first = tokens[0]?.type === 'word' ? tokens[0].value : '';
  const reads = LEXER_READ_STARTS[dialect]!;
  const c: Classification = {
    kind: reads.has(first) ? 'read' : (WRITE_WORDS[first] ?? 'unknown'),
    statement: first || '?',
    tables: [],
    reasons: [],
    dangerous: [],
  };
  if (c.kind === 'unknown')
    return unknown(first || '?', `${first || 'This'} is not a statement the guard knows. ${SIMPLIFY}`);
  if (dialect === 'oracle' && first === 'EXPLAIN') {
    c.kind = 'write';
    c.reasons.push('EXPLAIN PLAN writes into PLAN_TABLE');
  }
  if (dialect === 'clickhouse' && first === 'EXPLAIN' && tokens[1]?.value === 'ANALYZE')
    c.reasons.push('EXPLAIN ANALYZE runs the statement');
  if (c.kind !== 'read') c.reasons.push(`${c.statement} is not a read`);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type !== 'word' || tokens[i + 1]?.type === '(' || tokens[i - 1]?.type === '.') continue;
    const kind = WRITE_WORDS[t.value];
    if (kind && i > 0 && c.kind === 'read') {
      c.kind = kind;
      c.reasons.push(`contains ${t.value}`);
    }
    if ((t.value === 'FROM' || t.value === 'JOIN') && tokens[i + 1]) {
      const parts: string[] = [];
      let j = i + 1;
      while (tokens[j] && (tokens[j]!.type === 'word' || tokens[j]!.type === 'ident')) {
        parts.push(tokens[j]!.type === 'word' ? tokens[j]!.value.toLowerCase() : tokens[j]!.value);
        if (tokens[j + 1]?.type !== '.') break;
        j += 2;
      }
      if (parts.length && tokens[j + 1]?.type !== '(' && !['SELECT', 'DUAL'].includes(parts[0]!.toUpperCase()))
        c.tables.push(parts.join('.'));
    }
  }
  c.tables = [...new Set(c.tables)];
  if (first === 'DROP') c.dangerous.push('DROP removes objects and their data');
  if (first === 'TRUNCATE') c.dangerous.push('TRUNCATE removes every row');
  if ((first === 'UPDATE' || first === 'DELETE') && !tokens.some((t) => t.type === 'word' && t.value === 'WHERE'))
    c.dangerous.push(`${first} without WHERE changes every row`);
  if (first === 'ALTER' && tokens.some((t) => t.type === 'word' && t.value === 'DROP'))
    c.dangerous.push('ALTER … DROP removes a column or constraint');
  checkFunctions(c, dialect, functionCalls(tokens, NOT_FUNCTIONS), opts);
  lexerChecks(c, tokens, dialect);
  return c;
}

/** Keyword checks that do not depend on the parser (defense in depth). */
function lexerChecks(c: Classification, tokens: Token[], dialect: SqlDialect): void {
  const add = (reason: string) => {
    if (!c.reasons.includes(reason)) c.reasons.push(reason);
  };
  if (c.kind === 'read') {
    if (
      tokens.some((t) => t.type === 'word' && (t.value === 'INTO' || t.value === 'OUTFILE' || t.value === 'DUMPFILE'))
    )
      add('SELECT … INTO writes a table, a file or a variable');
    if (
      hasSequence(tokens, ['FOR', 'UPDATE']) ||
      hasSequence(tokens, ['FOR', 'SHARE']) ||
      hasSequence(tokens, ['FOR', 'NO', 'KEY', 'UPDATE']) ||
      hasSequence(tokens, ['FOR', 'KEY', 'SHARE']) ||
      hasSequence(tokens, ['LOCK', 'IN', 'SHARE', 'MODE'])
    )
      add('the locking clause locks rows');
    if (dialect === 'sqlserver') {
      for (const hint of ['UPDLOCK', 'XLOCK', 'HOLDLOCK', 'TABLOCK', 'TABLOCKX', 'PAGLOCK', 'SERIALIZABLE'])
        if (tokens.some((t) => t.type === 'word' && t.value === hint)) add(`the ${hint} hint locks data`);
      if (hasSequence(tokens, ['NEXT', 'VALUE', 'FOR'])) add('NEXT VALUE FOR advances a sequence');
    }
    if ((dialect === 'mysql' || dialect === 'mariadb') && hasSequence(tokens, ['EXPLAIN', 'ANALYZE']))
      add('EXPLAIN ANALYZE runs the statement');
  }
  // Denied functions found by the tokenizer, in case the parser represents a call differently.
  for (const call of functionCalls(tokens, NOT_FUNCTIONS)) {
    const denied = deniedReason(dialect, call.name, call.qualifier);
    if (!denied) continue;
    const label = call.qualifier ? `${call.qualifier}.${call.name}` : call.name;
    const reason = `${label}() ${denied}`;
    add(reason);
    if (!c.dangerous.includes(reason)) c.dangerous.push(reason);
  }
}

/** Classifies one SQL statement for the bridge. */
export function classifySql(
  dialect: SqlDialect,
  text: string,
  parsers: SqlParsers,
  opts: GuardOptions = { allowUserFunctions: false },
): Classification {
  let tokens: Token[];
  try {
    tokens = tokenize(text, dialect);
  } catch (e) {
    return unknown('?', `${e instanceof SqlLexError ? e.message : 'The statement could not be read.'} ${SIMPLIFY}`);
  }
  const statements = splitStatements(tokens);
  if (statements.length === 0) return unknown('?', 'The query is empty.');
  if (statements.length > 1) return unknown('?', `${statements.length} statements found; send one statement per call.`);
  const one = statements[0]!;
  switch (dialect) {
    case 'postgresql':
      return classifyPostgres(text, one, parsers, opts);
    case 'oracle':
    case 'clickhouse':
      return classifyByTokens(dialect, one, opts);
    default:
      return classifyGeneric(dialect, text, one, parsers, opts);
  }
}

export type GuardAction = 'run-read' | 'run-write' | 'ask' | 'reject';

export interface GuardDecision {
  action: GuardAction;
  /** For `reject` and `ask`: why (told to the agent / shown to the user). */
  message: string;
}

/** A plain read: no reasons against it. */
export const isCleanRead = (c: Classification): boolean => c.kind === 'read' && c.reasons.length === 0;

/**
 * What the bridge does with a classified statement in an access mode. Reads run in a read-only transaction;
 * writes run in a transaction committed after success.
 */
export function decide(mode: AccessMode, c: Classification, name: string): GuardDecision {
  const why = c.reasons.length ? ` (${c.reasons.join('; ')})` : '';
  if (c.kind === 'unknown') return { action: 'reject', message: `Refused: ${c.reasons.join(' ')}` };
  if (isCleanRead(c)) return { action: 'run-read', message: '' };
  if (mode === 'read-only')
    return {
      action: 'reject',
      message: `Refused: "${name}" is read-only for agents and this ${c.statement} is not a plain read${why}. Ask the user to change the database's access mode in Project settings → Databases if a write is needed.`,
    };
  if (mode === 'confirm-writes')
    return { action: 'ask', message: `${c.statement} on "${name}" needs the user's approval${why}.` };
  if (c.dangerous.length)
    return {
      action: 'ask',
      message: `${c.statement} on "${name}" always needs the user's approval (${c.dangerous.join('; ')}).`,
    };
  return { action: 'run-write', message: '' };
}
