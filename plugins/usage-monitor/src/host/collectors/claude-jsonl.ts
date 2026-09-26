import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { emptyTokens, type UsageRecord } from '../model';

const USAGE = Buffer.from('"usage"');

/** Fast path: only lines mentioning "usage" are decoded (most lines are message/tool content). */
export const acceptClaudeLine = (line: Buffer): boolean => line.includes(USAGE);

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** One transcript line → usage record (docs/plan/08-usage-monitor.md §5.3), or null. */
export function parseClaudeLine(text: string, filePath: string): UsageRecord | null {
  let o: Json;
  try {
    o = JSON.parse(text) as Json;
  } catch {
    return null;
  }
  const message = obj(o['message']);
  const usage = obj(message?.['usage']);
  if (o['type'] !== 'assistant' || !message || !usage) return null;
  const rawModel = typeof message['model'] === 'string' ? message['model'] : 'unknown';
  if (rawModel === '<synthetic>') return null;
  const ts = Date.parse(String(o['timestamp']));
  if (!Number.isFinite(ts)) return null;
  const messageId = typeof message['id'] === 'string' ? message['id'] : undefined;
  const requestId = typeof o['requestId'] === 'string' ? o['requestId'] : '';
  const uuid = typeof o['uuid'] === 'string' ? o['uuid'] : undefined;
  if (!messageId && !uuid) return null;
  const cacheCreation = obj(usage['cache_creation']);
  const tokens = emptyTokens();
  tokens.input = int(usage['input_tokens']);
  tokens.output = int(usage['output_tokens']);
  tokens.cacheRead = int(usage['cache_read_input_tokens']);
  if (cacheCreation) {
    tokens.cacheWrite5m = int(cacheCreation['ephemeral_5m_input_tokens']);
    tokens.cacheWrite1h = int(cacheCreation['ephemeral_1h_input_tokens']);
  } else tokens.cacheWrite5m = int(usage['cache_creation_input_tokens']);
  tokens.reasoning = int(obj(usage['output_tokens_details'])?.['thinking_tokens']);
  const speed = usage['speed'] === 'fast' || usage['speed'] === 'standard' ? usage['speed'] : undefined;
  const serviceTier = typeof usage['service_tier'] === 'string' ? usage['service_tier'] : undefined;
  const inferenceGeo = typeof usage['inference_geo'] === 'string' ? usage['inference_geo'] : undefined;
  const webSearchRequests = int(obj(usage['server_tool_use'])?.['web_search_requests']);
  const reported = typeof o['costUSD'] === 'number' ? o['costUSD'] : null;
  return {
    id: messageId ? `claude:${messageId}:${requestId}` : `claude:uuid:${uuid}`,
    ts,
    agent: 'claude-code',
    provider: 'anthropic',
    rawModel,
    ...(typeof o['sessionId'] === 'string' ? { sessionId: o['sessionId'] } : {}),
    ...(typeof o['cwd'] === 'string' ? { cwd: o['cwd'] } : {}),
    isSubagent:
      o['isSidechain'] === true || filePath.includes(`${sep}subagents${sep}`) || filePath.includes('/subagents/'),
    tokens,
    extras: {
      ...(speed ? { speed } : {}),
      ...(serviceTier ? { serviceTier } : {}),
      ...(inferenceGeo ? { inferenceGeo } : {}),
      ...(webSearchRequests ? { webSearchRequests } : {}),
    },
    reportedCostUsd: reported,
    source: 'claude-jsonl',
  };
}

/**
 * Claude configuration folders (§5.1): `CLAUDE_CONFIG_DIR` (comma separated), `~/.claude`, `~/.config/claude` and
 * extra folders from settings — existing ones only, deduplicated by real path. Transcripts: `<dir>/projects/**`.
 */
export function claudeProjectDirs(env: NodeJS.ProcessEnv, extraDirs: string[] = [], home = homedir()): string[] {
  const candidates = [
    ...(env['CLAUDE_CONFIG_DIR'] ?? '').split(',').map((d) => d.trim()),
    join(home, '.claude'),
    join(home, '.config', 'claude'),
    ...extraDirs,
  ].filter(Boolean);
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of candidates) {
    const projects = join(dir, 'projects');
    if (!existsSync(projects)) continue;
    let real: string;
    try {
      real = realpathSync(projects);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    dirs.push(real);
  }
  return dirs;
}
