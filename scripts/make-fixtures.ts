/**
 * Anonymizes agent logs into Usage Monitor test fixtures (docs/plan/08-usage-monitor.md §18): keeps only usage
 * metadata (ids, timestamps, models, token counts, cwd) and drops every message, prompt, tool input/output and
 * thought. Paths are replaced by `/fixture/proj` (or the value of `--cwd`).
 *
 * Usage: `tsx scripts/make-fixtures.ts --source claude|codex|gemini --in <file.jsonl> --out <file.jsonl>
 *         [--cwd /fixture/proj] [--limit <usage records>]`
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

type Json = Record<string, unknown>;
type Source = 'claude' | 'codex' | 'gemini';

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function pick(o: Json, keys: string[]): Json {
  const out: Json = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/** Claude Code transcript line → usage metadata only (`null` = drop the line). */
export function anonymizeClaude(o: Json, cwd: string): Json | null {
  if (o['type'] !== 'assistant' && o['type'] !== 'user') return null;
  const out = pick(o, ['type', 'timestamp', 'sessionId', 'uuid', 'parentUuid', 'isSidechain', 'version', 'requestId']);
  if (typeof o['cwd'] === 'string') out['cwd'] = cwd;
  const message = isObject(o['message']) ? o['message'] : null;
  if (message) {
    const m = pick(message, ['id', 'type', 'role', 'model', 'usage', 'stop_reason']);
    // Content blocks are replaced by their types only.
    if (Array.isArray(message['content']))
      m['content'] = message['content'].map((b) => (isObject(b) ? { type: b['type'] } : { type: 'text' }));
    out['message'] = m;
  }
  if (typeof o['costUSD'] === 'number') out['costUSD'] = o['costUSD'];
  return out;
}

/** Codex rollout line → session/model/token metadata only. */
export function anonymizeCodex(o: Json, cwd: string): Json | null {
  const payload = isObject(o['payload']) ? o['payload'] : {};
  if (o['type'] === 'session_meta') {
    const p = pick(payload, ['id', 'timestamp', 'originator', 'cli_version']);
    if (typeof payload['cwd'] === 'string') p['cwd'] = cwd;
    return { timestamp: o['timestamp'], type: 'session_meta', payload: p };
  }
  if (o['type'] === 'turn_context') {
    const p = pick(payload, ['model', 'effort', 'service_tier']);
    if (typeof payload['cwd'] === 'string') p['cwd'] = cwd;
    return { timestamp: o['timestamp'], type: 'turn_context', payload: p };
  }
  if (o['type'] === 'event_msg' && payload['type'] === 'token_count')
    return { timestamp: o['timestamp'], type: 'event_msg', payload: pick(payload, ['type', 'info', 'rate_limits']) };
  return null;
}

/** Gemini CLI chat record → metadata and message token records only. */
export function anonymizeGemini(o: Json): Json | null {
  if (typeof o['sessionId'] === 'string' && typeof o['projectHash'] === 'string')
    return pick(o, ['sessionId', 'projectHash', 'startTime', 'lastUpdated', 'kind']);
  if (isObject(o['$set'])) {
    const set = pick(o['$set'], ['lastUpdated']);
    return Object.keys(set).length > 0 ? { $set: set } : null;
  }
  if (typeof o['id'] === 'string' && typeof o['type'] === 'string') {
    const m = pick(o, ['id', 'timestamp', 'type', 'model', 'tokens']);
    m['content'] = '';
    return m;
  }
  return null;
}

function hasUsage(source: Source, o: Json): boolean {
  if (source === 'claude') return isObject(o['message']) && isObject(o['message']['usage']);
  if (source === 'codex') return isObject(o['payload']) && o['payload']['type'] === 'token_count';
  return isObject(o['tokens']);
}

export function anonymize(source: Source, text: string, opts: { cwd: string; limit?: number }): string {
  const out: string[] = [];
  let usage = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(o)) continue;
    const a =
      source === 'claude'
        ? anonymizeClaude(o, opts.cwd)
        : source === 'codex'
          ? anonymizeCodex(o, opts.cwd)
          : anonymizeGemini(o);
    if (!a) continue;
    if (hasUsage(source, a)) {
      if (opts.limit !== undefined && usage >= opts.limit) break;
      usage++;
    }
    out.push(JSON.stringify(a));
  }
  return out.length > 0 ? `${out.join('\n')}\n` : '';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const source = arg('source') as Source | undefined;
  const input = arg('in');
  const output = arg('out');
  if (!source || !['claude', 'codex', 'gemini'].includes(source) || !input || !output) {
    console.error('Usage: tsx scripts/make-fixtures.ts --source claude|codex|gemini --in <file> --out <file>');
    process.exit(2);
  }
  const limit = arg('limit');
  const result = anonymize(source, await readFile(input, 'utf8'), {
    cwd: arg('cwd') ?? '/fixture/proj',
    ...(limit ? { limit: Number(limit) } : {}),
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, result);
  console.log(`${output}: ${result.split('\n').length - 1} lines`);
}

if (process.argv[1]?.endsWith('make-fixtures.ts')) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
