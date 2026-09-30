import { matchesAny } from '@shared/utils/glob';
import { scalarText } from '@shared/utils/text';

export interface Column {
  name: string;
  type?: string;
}

/** Rows of a query as a driver returns them (capped at `maxRows + 1` by the driver). */
export interface ResultSet {
  columns: Column[];
  rows: unknown[][];
  /** Rows the query produced in total; null when unknown (more rows exist but were not counted). */
  total: number | null;
  /** Rows changed by a write (INSERT/UPDATE/DELETE). */
  affected?: number;
  /** e.g. "UPDATE 3". */
  command?: string;
}

export const MASK = '***';
export const MAX_CELL_CHARS = 2000;

const isBinary = (v: unknown): v is Uint8Array =>
  v instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(v));

/** A cell as text: NULL, ISO dates, `<binary N bytes>`, JSON for objects, long values cut. */
export function formatCell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Date) text = Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  else if (isBinary(value)) return `<binary ${value.byteLength.toLocaleString('en-US')} bytes>`;
  else if (typeof value === 'bigint') text = value.toString();
  else if (typeof value === 'object') text = safeJson(value);
  else text = scalarText(value);
  if (text.length > MAX_CELL_CHARS)
    return `${text.slice(0, MAX_CELL_CHARS)}… (${(text.length - MAX_CELL_CHARS).toLocaleString('en-US')} more characters)`;
  return text;
}

/** JSON for any value: bigint as string, binary described, dates in ISO 8601, cycles cut. */
export function safeJson(value: unknown, indent?: number): string {
  const seen = new WeakSet<object>();
  return (
    JSON.stringify(
      value,
      function (this: unknown, _key, v: unknown) {
        if (typeof v === 'bigint') return v.toString();
        if (isBinary(v)) return `<binary ${v.byteLength} bytes>`;
        if (
          v &&
          typeof v === 'object' &&
          (v as { type?: unknown }).type === 'Buffer' &&
          Array.isArray((v as { data?: unknown }).data)
        )
          return `<binary ${(v as { data: unknown[] }).data.length} bytes>`;
        if (v && typeof v === 'object') {
          if (seen.has(v)) return '[circular]';
          seen.add(v);
        }
        return v;
      },
      indent,
    ) ?? 'null'
  );
}

/** A value for JSON output: masked, binary described, long strings cut. */
function jsonCell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (isBinary(value)) return `<binary ${value.byteLength} bytes>`;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' && value.length > MAX_CELL_CHARS)
    return `${value.slice(0, MAX_CELL_CHARS)}… (${value.length - MAX_CELL_CHARS} more characters)`;
  if (typeof value === 'object') {
    const text = safeJson(value);
    if (text.length > MAX_CELL_CHARS) return `${text.slice(0, MAX_CELL_CHARS)}…`;
    return JSON.parse(text) as unknown;
  }
  return value;
}

const escapeCell = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '\\n');

/**
 * Masks values of columns/fields whose name matches a masking glob, anywhere in nested objects (JSON columns,
 * MongoDB documents).
 */
export function maskValue(value: unknown, masking: readonly string[], depth = 0): unknown {
  if (depth > 50 || value === null || typeof value !== 'object' || value instanceof Date || isBinary(value))
    return value;
  if (Array.isArray(value)) return value.map((v) => maskValue(v, masking, depth + 1));
  const typed = value as { _bsontype?: unknown; toJSON?: unknown };
  // BSON values (ObjectId, Decimal128, …) render through toJSON / toString.
  if (typed._bsontype) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    out[k] = matchesAny(k, masking) ? MASK : maskValue(v, masking, depth + 1);
  return out;
}

export function maskRows(result: ResultSet, masking: readonly string[]): ResultSet {
  if (masking.length === 0) return result;
  const masked = result.columns.map((c) => matchesAny(c.name, masking));
  return {
    ...result,
    rows: result.rows.map((row) => row.map((v, i) => (masked[i] ? (v === null ? null : MASK) : maskValue(v, masking)))),
  };
}

export interface FormatOptions {
  format: 'markdown' | 'json';
  maxRows: number;
  maxBytes: number;
}

const n = (x: number) => x.toLocaleString('en-US');

/** The agent's view of a result: header with the row counts, then a Markdown table or JSON. */
export function formatResult(result: ResultSet, o: FormatOptions): string {
  const shownRows = result.rows.slice(0, o.maxRows);
  const more = result.rows.length > o.maxRows || (result.total !== null && result.total > shownRows.length);
  const header: string[] = [];
  if (result.command) header.push(result.command);
  if (result.affected !== undefined && result.columns.length === 0)
    return [...header, `${n(result.affected)} row${result.affected === 1 ? '' : 's'} affected.`].join('\n');
  if (result.columns.length === 0) return [...header, 'Done (no rows returned).'].join('\n');

  const types = result.columns.map((c) => (c.type ? `${c.name} (${c.type})` : c.name)).join(', ');
  const lines: string[] = [];
  let bytes = 0;
  let kept = 0;
  const budget = Math.max(1024, o.maxBytes - 1024);
  if (o.format === 'json') {
    const objects: string[] = [];
    for (const row of shownRows) {
      const obj: Record<string, unknown> = {};
      result.columns.forEach((c, i) => (obj[c.name] = jsonCell(row[i])));
      const text = safeJson(obj);
      if (bytes + text.length > budget) break;
      bytes += text.length + 2;
      objects.push(text);
      kept++;
    }
    lines.push(`[\n  ${objects.join(',\n  ')}\n]`);
  } else {
    lines.push(`| ${result.columns.map((c) => escapeCell(c.name)).join(' | ')} |`);
    lines.push(`| ${result.columns.map(() => '---').join(' | ')} |`);
    for (const row of shownRows) {
      const line = `| ${row.map((v) => escapeCell(formatCell(v))).join(' | ')} |`;
      if (bytes + line.length > budget) break;
      bytes += line.length + 1;
      lines.push(line);
      kept++;
    }
  }
  const total =
    result.total !== null ? n(result.total) : more ? `more than ${n(shownRows.length)}` : n(shownRows.length);
  let summary: string;
  if (kept < shownRows.length)
    summary = `${n(kept)} of ${total} rows shown (the ${Math.round(o.maxBytes / 1024)} KB result limit) — select fewer columns or add a WHERE or LIMIT.`;
  else if (more) summary = `${n(kept)} of ${total} rows shown — add a WHERE or LIMIT.`;
  else summary = `${n(kept)} row${kept === 1 ? '' : 's'}.`;
  return [...header, `Columns: ${types}`, summary, '', ...lines].join('\n');
}

// ── secrets in errors ──

const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^:/?#@\s]*):([^@/\s]*)@/gi;
const KEY_VALUE_SECRETS =
  /\b(password|pwd|passwd|secret|token|apikey|api_key|accountkey|sharedaccesskey)\s*=\s*("[^"]*"|'[^']*'|[^;&\s]*)/gi;

/**
 * Removes secrets from a message before it leaves the Connections Host: the given values (plain and URL-encoded),
 * credentials in URLs and `Password=…` pairs of connection strings.
 */
export function scrub(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (!secret || secret.length < 3) continue;
    for (const variant of new Set([secret, encodeURIComponent(secret)])) out = out.split(variant).join(MASK);
  }
  return out.replace(URL_CREDENTIALS, `$1$2:${MASK}@`).replace(KEY_VALUE_SECRETS, `$1=${MASK}`);
}
