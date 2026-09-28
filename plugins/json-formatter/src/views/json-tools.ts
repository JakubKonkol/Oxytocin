/** JSON formatting of the JSON Formatter panel (pure, unit-tested). */

export type Indent = '2' | '4' | 'tab';

export type JsonResult =
  { ok: true; text: string; summary: string } | { ok: false; error: string; line?: number; column?: number };

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort((a, b) => a.localeCompare(b))
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  return value;
}

/** "object · 12 keys" · "array · 3 items" · "string". */
export function describe(value: unknown): string {
  if (Array.isArray(value)) return `array · ${value.length} ${value.length === 1 ? 'item' : 'items'}`;
  if (value === null) return 'null';
  if (typeof value === 'object') {
    const n = Object.keys(value).length;
    return `object · ${n} ${n === 1 ? 'key' : 'keys'}`;
  }
  return typeof value;
}

/** Line and column (1-based) of a character offset. */
export function position(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, offset));
  const line = before.split('\n').length;
  return { line, column: offset - before.lastIndexOf('\n') };
}

/** Parses JSON and reports errors with a line and column when the engine gives an offset. */
export function parse(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string; line?: number; column?: number } {
  if (text.trim() === '') return { ok: false, error: 'Paste or type JSON' };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // V8: "… in JSON at position 12 (line 2 column 5)" or "… at position 12".
    const lineCol = /line (\d+) column (\d+)/.exec(message);
    if (lineCol) return { ok: false, error: message, line: Number(lineCol[1]), column: Number(lineCol[2]) };
    const offset = /position (\d+)/.exec(message)?.[1];
    const at = offset !== undefined ? Number(offset) : errorOffset(text);
    if (at !== null) return { ok: false, error: message, ...position(text, at) };
    return { ok: false, error: message };
  }
}

class SyntaxAt extends Error {
  constructor(readonly offset: number) {
    super(`Syntax error at ${offset}`);
  }
}

/**
 * Offset of the first syntax error, for engines whose messages leave it out ("Unexpected token '}', … is not
 * valid JSON"). A small recursive-descent scan; null when the text looks valid.
 */
export function errorOffset(text: string): number | null {
  let i = 0;
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++;
  };
  const fail = (): never => {
    throw new SyntaxAt(i);
  };
  const literal = (word: string) => {
    if (text.startsWith(word, i)) i += word.length;
    else fail();
  };
  const string = () => {
    i++; // opening quote
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') i++;
      else if (text.charCodeAt(i) < 0x20) fail();
      i++;
    }
    if (i >= text.length) fail();
    i++;
  };
  const number = () => {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) fail();
    i += m![0].length;
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      if (text[i] === '}') return void i++;
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        string();
        ws();
        if (text[i] !== ':') fail();
        i++;
        value();
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === '}') return void i++;
        else fail();
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') return void i++;
      for (;;) {
        value();
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === ']') return void i++;
        else fail();
      }
    }
    if (c === '"') return string();
    if (c === 't') return literal('true');
    if (c === 'f') return literal('false');
    if (c === 'n') return literal('null');
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return number();
    fail();
  };
  try {
    value();
    ws();
    return i < text.length ? i : null;
  } catch (e) {
    return e instanceof SyntaxAt ? e.offset : null;
  }
}

export function format(text: string, opts: { indent: Indent; sortKeys: boolean }): JsonResult {
  const parsed = parse(text);
  if (!parsed.ok) return parsed;
  const value = opts.sortKeys ? sortKeys(parsed.value) : parsed.value;
  return {
    ok: true,
    text: JSON.stringify(value, null, opts.indent === 'tab' ? '\t' : Number(opts.indent)),
    summary: describe(parsed.value),
  };
}

export function minify(text: string, opts: { sortKeys: boolean }): JsonResult {
  const parsed = parse(text);
  if (!parsed.ok) return parsed;
  const value = opts.sortKeys ? sortKeys(parsed.value) : parsed.value;
  return { ok: true, text: JSON.stringify(value), summary: describe(parsed.value) };
}
