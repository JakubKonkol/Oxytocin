import { parse as parseYaml } from 'yaml';
import { scalarText } from '@shared/utils/text';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export const OPENAPI_CANDIDATES = [
  '/swagger/v1/swagger.json',
  '/openapi.json',
  '/v3/api-docs',
  '/swagger.json',
  '/openapi.yaml',
  '/api-docs',
];

const METHODS = ['get', 'head', 'options', 'post', 'put', 'patch', 'delete'] as const;

export interface Operation {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  tags: string[];
  spec: Obj;
}

/** Parses a JSON or YAML document into an OpenAPI 3 / Swagger 2 object (null when it is not one). */
export function parseSpec(text: string): Obj | null {
  let doc: unknown;
  const trimmed = text.trim();
  try {
    doc = trimmed.startsWith('{') ? JSON.parse(trimmed) : parseYaml(trimmed);
  } catch {
    return null;
  }
  if (!isObj(doc) || !isObj(doc['paths']) || !(doc['openapi'] || doc['swagger'])) return null;
  return doc;
}

export function operations(spec: Obj): Operation[] {
  const out: Operation[] = [];
  for (const [path, item] of Object.entries(isObj(spec['paths']) ? spec['paths'] : {})) {
    if (!isObj(item)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      out.push({
        method: method.toUpperCase(),
        path,
        ...(typeof op['operationId'] === 'string' ? { operationId: op['operationId'] } : {}),
        ...(typeof op['summary'] === 'string'
          ? { summary: op['summary'] }
          : typeof op['description'] === 'string'
            ? { summary: op['description'].split('\n')[0]!.slice(0, 160) }
            : {}),
        tags: Array.isArray(op['tags']) ? op['tags'].filter((t): t is string => typeof t === 'string') : [],
        spec: { ...op, ...(Array.isArray(item['parameters']) ? { pathParameters: item['parameters'] } : {}) },
      });
    }
  }
  return out;
}

/** Follows a local `$ref` (`#/components/schemas/User`). */
function deref(spec: Obj, value: unknown): unknown {
  if (!isObj(value) || typeof value['$ref'] !== 'string') return value;
  const ref = value['$ref'];
  if (!ref.startsWith('#/')) return value;
  let cur: unknown = spec;
  for (const part of ref.slice(2).split('/'))
    cur = isObj(cur) ? cur[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
  return cur ?? value;
}

const refName = (value: unknown): string | undefined =>
  isObj(value) && typeof value['$ref'] === 'string' ? value['$ref'].split('/').pop() : undefined;

/** A JSON Schema as a compact TypeScript-like type (depth-limited, $refs named). */
export function schemaText(spec: Obj, schema: unknown, depth = 0, seen = new Set<string>()): string {
  const name = refName(schema);
  if (name && (depth >= 3 || seen.has(name))) return name;
  const s = deref(spec, schema);
  if (!isObj(s)) return 'unknown';
  const nextSeen = name ? new Set([...seen, name]) : seen;
  const nullable = s['nullable'] === true ? ' | null' : '';
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const list = s[key];
    if (Array.isArray(list))
      return list.map((x) => schemaText(spec, x, depth + 1, nextSeen)).join(key === 'allOf' ? ' & ' : ' | ') + nullable;
  }
  if (Array.isArray(s['enum'])) return s['enum'].map((v) => JSON.stringify(v)).join(' | ') + nullable;
  const type = Array.isArray(s['type'])
    ? s['type'].join(' | ')
    : typeof s['type'] === 'string'
      ? s['type']
      : s['properties']
        ? 'object'
        : undefined;
  if (type === 'array') return `${schemaText(spec, s['items'], depth + 1, nextSeen)}[]${nullable}`;
  if (type === 'object' || s['properties']) {
    const props = isObj(s['properties']) ? s['properties'] : {};
    if (depth >= 4 || Object.keys(props).length === 0) return (name ?? 'object') + nullable;
    const required = new Set(Array.isArray(s['required']) ? (s['required'] as string[]) : []);
    const fields = Object.entries(props)
      .slice(0, 60)
      .map(([k, v]) => `${k}${required.has(k) ? '' : '?'}: ${schemaText(spec, v, depth + 1, nextSeen)}`);
    return `{ ${fields.join('; ')} }${nullable}`;
  }
  const format = typeof s['format'] === 'string' ? ` (${s['format']})` : '';
  return `${type ?? 'unknown'}${format}${nullable}`;
}

/** One operation in full: parameters, request body and responses. */
export function describeOperation(spec: Obj, op: Operation): string {
  const lines = [`${op.method} ${op.path}${op.operationId ? ` [${op.operationId}]` : ''}`];
  if (op.summary) lines.push(op.summary);
  const params = [
    ...(Array.isArray(op.spec['pathParameters']) ? (op.spec['pathParameters'] as unknown[]) : []),
    ...(Array.isArray(op.spec['parameters']) ? (op.spec['parameters'] as unknown[]) : []),
  ].map((p) => deref(spec, p));
  if (params.length) {
    lines.push('Parameters:');
    for (const p of params) {
      if (!isObj(p)) continue;
      const type = p['schema'] ? schemaText(spec, p['schema']) : typeof p['type'] === 'string' ? p['type'] : 'string';
      lines.push(
        `  ${String(p['name'])} (${String(p['in'])}${p['required'] ? ', required' : ''}): ${type}${typeof p['description'] === 'string' ? ` — ${p['description'].slice(0, 200)}` : ''}`,
      );
    }
  }
  const body = deref(spec, op.spec['requestBody']);
  if (isObj(body) && isObj(body['content'])) {
    for (const [type, media] of Object.entries(body['content'])) {
      if (!isObj(media)) continue;
      lines.push(`Body (${type}${body['required'] ? ', required' : ''}): ${schemaText(spec, media['schema'])}`);
    }
  }
  // Swagger 2 body parameter.
  for (const p of params) if (isObj(p) && p['in'] === 'body') lines.push(`Body: ${schemaText(spec, p['schema'])}`);
  const responses = isObj(op.spec['responses']) ? op.spec['responses'] : {};
  if (Object.keys(responses).length) lines.push('Responses:');
  for (const [code, raw] of Object.entries(responses)) {
    const r = deref(spec, raw);
    if (!isObj(r)) continue;
    const content = isObj(r['content']) ? Object.entries(r['content']) : [];
    const schema = content.find(([t]) => t.includes('json'))?.[1] ?? content[0]?.[1];
    const type =
      isObj(schema) && schema['schema']
        ? schemaText(spec, schema['schema'])
        : r['schema']
          ? schemaText(spec, r['schema'])
          : '';
    lines.push(
      `  ${code}${typeof r['description'] === 'string' ? ` ${r['description'].slice(0, 120)}` : ''}${type ? `: ${type}` : ''}`,
    );
  }
  return lines.join('\n');
}

/** The operation list, or one operation (by operationId or "METHOD /path"). */
export function summarizeSpec(
  spec: Obj,
  o: { filter?: string; operation?: string; allowed: (method: string, path: string) => boolean },
): string {
  const ops = operations(spec);
  const info = isObj(spec['info']) ? spec['info'] : {};
  if (o.operation) {
    const wanted = o.operation.trim();
    const [m, p] = wanted.split(/\s+/, 2);
    const op =
      ops.find((x) => x.operationId === wanted) ??
      ops.find((x) => p && x.method === m!.toUpperCase() && x.path === p) ??
      ops.find((x) => x.operationId?.toLowerCase() === wanted.toLowerCase());
    if (!op) return `No operation "${wanted}". Call oxy_api_describe without \`operation\` to list them.`;
    return `${describeOperation(spec, op)}${o.allowed(op.method, op.path) ? '' : '\n(Not allowed for agents on this API.)'}`;
  }
  const filter = o.filter?.toLowerCase();
  const shown = ops.filter(
    (x) =>
      !filter ||
      x.path.toLowerCase().includes(filter) ||
      x.summary?.toLowerCase().includes(filter) ||
      x.operationId?.toLowerCase().includes(filter) ||
      x.tags.some((t) => t.toLowerCase().includes(filter)),
  );
  const title = `${scalarText(info['title'], 'API')}${info['version'] ? ` ${scalarText(info['version'])}` : ''} — ${ops.length} operation${ops.length === 1 ? '' : 's'}${filter ? `, ${shown.length} matching "${o.filter}"` : ''}`;
  const lines = shown
    .slice(0, 300)
    .map(
      (x) =>
        `${x.method} ${x.path}${x.summary ? ` — ${x.summary}` : ''}${x.operationId ? ` [${x.operationId}]` : ''}${o.allowed(x.method, x.path) ? '' : ' (not allowed)'}`,
    );
  if (shown.length > 300) lines.push(`… ${shown.length - 300} more; pass \`filter\`.`);
  return `${title}\n${lines.join('\n')}\nPass \`operation\` (an operationId or "METHOD /path") for its parameters, body and responses.`;
}
