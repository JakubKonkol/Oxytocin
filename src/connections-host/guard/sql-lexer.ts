import type { SqlDialect } from '@shared/domain/project-resources';

export type TokenType = 'word' | 'ident' | 'string' | 'number' | 'param' | 'op' | '(' | ')' | ',' | '.' | ';';

export interface Token {
  type: TokenType;
  /** Words: upper case. Quoted identifiers: the name without quotes. Other tokens: the text. */
  value: string;
  start: number;
}

export class SqlLexError extends Error {}

interface DialectRules {
  hashComments: boolean;
  nestedComments: boolean;
  /** Double quotes delimit strings instead of identifiers (MySQL without ANSI_QUOTES). */
  doubleQuoteStrings: boolean;
  backticks: boolean;
  brackets: boolean;
  backslashEscapes: boolean;
  dollarQuotes: boolean;
}

const RULES: Record<SqlDialect, DialectRules> = {
  postgresql: {
    hashComments: false,
    nestedComments: true,
    doubleQuoteStrings: false,
    backticks: false,
    brackets: false,
    backslashEscapes: false,
    dollarQuotes: true,
  },
  mysql: {
    hashComments: true,
    nestedComments: false,
    doubleQuoteStrings: true,
    backticks: true,
    brackets: false,
    backslashEscapes: true,
    dollarQuotes: false,
  },
  mariadb: {
    hashComments: true,
    nestedComments: false,
    doubleQuoteStrings: true,
    backticks: true,
    brackets: false,
    backslashEscapes: true,
    dollarQuotes: false,
  },
  sqlserver: {
    hashComments: false,
    nestedComments: true,
    doubleQuoteStrings: false,
    backticks: false,
    brackets: true,
    backslashEscapes: false,
    dollarQuotes: false,
  },
  sqlite: {
    hashComments: false,
    nestedComments: false,
    doubleQuoteStrings: false,
    backticks: true,
    brackets: true,
    backslashEscapes: false,
    dollarQuotes: false,
  },
  clickhouse: {
    hashComments: true,
    nestedComments: true,
    doubleQuoteStrings: false,
    backticks: true,
    brackets: false,
    backslashEscapes: true,
    dollarQuotes: false,
  },
  oracle: {
    hashComments: false,
    nestedComments: false,
    doubleQuoteStrings: false,
    backticks: false,
    brackets: false,
    backslashEscapes: false,
    dollarQuotes: false,
  },
};

const isWordStart = (c: string) => /[A-Za-z_\u0080-￿]/.test(c);
const isWordPart = (c: string) => /[A-Za-z0-9_$#@\u0080-￿]/.test(c);

/**
 * A tokenizer that knows each dialect's comments, strings and quoted identifiers. The guard uses it to count
 * statements and to find keywords and function calls without being fooled by comments or string contents.
 * Unterminated strings, identifiers and comments throw (the statement is rejected).
 */
export function tokenize(text: string, dialect: SqlDialect): Token[] {
  const r = RULES[dialect];
  const tokens: Token[] = [];
  let i = 0;
  const n = text.length;
  const readQuoted = (open: number, close: string, backslash: boolean): string => {
    let out = '';
    let j = open + 1;
    while (j < n) {
      const c = text[j]!;
      if (backslash && c === '\\' && j + 1 < n) {
        out += text[j + 1];
        j += 2;
        continue;
      }
      if (c === close) {
        if (text[j + 1] === close) {
          out += close;
          j += 2;
          continue;
        }
        i = j + 1;
        return out;
      }
      out += c;
      j++;
    }
    throw new SqlLexError(`Unterminated ${close === "'" ? 'string' : 'quoted identifier'} at position ${open + 1}.`);
  };
  while (i < n) {
    const c = text[i]!;
    const next = text[i + 1];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '-' && next === '-') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === '#' && r.hashComments) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === '/' && next === '*') {
      // MySQL/MariaDB run the contents of /*! … */ and /*M! … */ as SQL: they are not comments there.
      if ((dialect === 'mysql' || dialect === 'mariadb') && /^\/\*(!|M!)/.test(text.slice(i, i + 4)))
        throw new SqlLexError('Executable comments (/*! … */) are not allowed; write the SQL without them.');
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === '*' && text[j + 1] === '/') {
          depth--;
          j += 2;
        } else if (r.nestedComments && text[j] === '/' && text[j + 1] === '*') {
          depth++;
          j += 2;
        } else j++;
      }
      if (depth > 0) throw new SqlLexError('Unterminated /* comment.');
      i = j;
      continue;
    }
    const start = i;
    // Prefixed strings: E'…' (PostgreSQL escapes), N'…', X'…', B'…', q'[…]' (Oracle).
    if (/[eEnNxXbBuU]/.test(c) && next === "'") {
      const backslash = r.backslashEscapes || ((c === 'e' || c === 'E') && dialect === 'postgresql');
      tokens.push({ type: 'string', value: readQuoted(i + 1, "'", backslash), start });
      continue;
    }
    if (dialect === 'oracle' && (c === 'q' || c === 'Q') && next === "'") {
      const open = text[i + 2];
      const pairs: Record<string, string> = { '[': ']', '(': ')', '{': '}', '<': '>' };
      const close = open ? (pairs[open] ?? open) : undefined;
      const end = close ? text.indexOf(`${close}'`, i + 3) : -1;
      if (end < 0) throw new SqlLexError(`Unterminated q'…' string at position ${i + 1}.`);
      tokens.push({ type: 'string', value: text.slice(i + 3, end), start });
      i = end + 2;
      continue;
    }
    if (c === "'") {
      tokens.push({ type: 'string', value: readQuoted(i, "'", r.backslashEscapes), start });
      continue;
    }
    if (c === '"') {
      if (r.doubleQuoteStrings) tokens.push({ type: 'string', value: readQuoted(i, '"', r.backslashEscapes), start });
      else tokens.push({ type: 'ident', value: readQuoted(i, '"', false), start });
      continue;
    }
    if (c === '`' && r.backticks) {
      tokens.push({ type: 'ident', value: readQuoted(i, '`', false), start });
      continue;
    }
    if (c === '[' && r.brackets) {
      tokens.push({ type: 'ident', value: readQuoted(i, ']', false), start });
      continue;
    }
    if (c === '$' && r.dollarQuotes) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (tag) {
        const end = text.indexOf(tag[0], i + tag[0].length);
        if (end < 0) throw new SqlLexError(`Unterminated ${tag[0]} string at position ${i + 1}.`);
        tokens.push({ type: 'string', value: text.slice(i + tag[0].length, end), start });
        i = end + tag[0].length;
        continue;
      }
      const param = /^\$\d+/.exec(text.slice(i));
      if (param) {
        tokens.push({ type: 'param', value: param[0], start });
        i += param[0].length;
        continue;
      }
    }
    if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWordPart(text[j]!)) j++;
      tokens.push({ type: 'word', value: text.slice(i, j).toUpperCase(), start });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && next !== undefined && /[0-9]/.test(next))) {
      const m = /^(0x[0-9a-fA-F]+|\d*\.?\d+(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
      const len = m ? m[0].length : 1;
      tokens.push({ type: 'number', value: text.slice(i, i + len), start });
      i += len;
      continue;
    }
    if (c === '?' || ((c === ':' || c === '@') && next !== undefined && /[A-Za-z0-9_]/.test(next))) {
      if (c === '@' && next === '@') {
        // @@VERSION and friends (T-SQL/MySQL system variables): a word.
        let j = i + 2;
        while (j < n && isWordPart(text[j]!)) j++;
        tokens.push({ type: 'word', value: text.slice(i, j).toUpperCase(), start });
        i = j;
        continue;
      }
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(text[j]!)) j++;
      tokens.push({ type: 'param', value: text.slice(i, j), start });
      i = j;
      continue;
    }
    if (c === '(' || c === ')' || c === ',' || c === '.' || c === ';') {
      tokens.push({ type: c, value: c, start });
      i++;
      continue;
    }
    // Operators: take a run of operator characters.
    let j = i + 1;
    while (j < n && /[<>=!~^&|%*+\-/:?@#]/.test(text[j]!) && !(text[j] === '-' && text[j + 1] === '-')) j++;
    tokens.push({ type: 'op', value: text.slice(i, j), start });
    i = j;
  }
  return tokens;
}

/** Splits tokens into statements at `;` (empty statements are dropped). */
export function splitStatements(tokens: Token[]): Token[][] {
  const out: Token[][] = [];
  let current: Token[] = [];
  for (const t of tokens) {
    if (t.type === ';') {
      if (current.length) out.push(current);
      current = [];
    } else current.push(t);
  }
  if (current.length) out.push(current);
  return out;
}

/** Words (upper case) at any position. */
export const words = (tokens: Token[]): string[] => tokens.filter((t) => t.type === 'word').map((t) => t.value);

/** True when the words appear in this order next to each other (e.g. FOR UPDATE). */
export function hasSequence(tokens: Token[], sequence: string[]): boolean {
  for (let i = 0; i + sequence.length <= tokens.length; i++) {
    if (sequence.every((w, k) => tokens[i + k]?.type === 'word' && tokens[i + k]!.value === w)) return true;
  }
  return false;
}

export interface FunctionCall {
  /** Lower case, without the schema. */
  name: string;
  /** Lower case qualifier (`dbms_lock` in `dbms_lock.sleep(…)`), if any. */
  qualifier?: string;
}

/** Words and quoted identifiers followed by `(`, minus the keywords in `notFunctions`. */
export function functionCalls(tokens: Token[], notFunctions: ReadonlySet<string>): FunctionCall[] {
  const out: FunctionCall[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i]!;
    if ((t.type !== 'word' && t.type !== 'ident') || tokens[i + 1]!.type !== '(') continue;
    const qualified = tokens[i - 1]?.type === '.';
    if (t.type === 'word' && !qualified && notFunctions.has(t.value)) continue;
    const qualifierToken = qualified ? tokens[i - 2] : undefined;
    const qualifier =
      qualifierToken && (qualifierToken.type === 'word' || qualifierToken.type === 'ident')
        ? qualifierToken.value.toLowerCase()
        : undefined;
    out.push({ name: t.value.toLowerCase(), ...(qualifier ? { qualifier } : {}) });
  }
  return out;
}
