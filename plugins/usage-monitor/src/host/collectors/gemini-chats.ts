import { homedir } from 'node:os';
import { join } from 'node:path';
import { type CollectedItem, emptyTokens, type UsageRecord } from '../model';

const MARKERS = ['"tokens"', '"projectHash"'].map((m) => Buffer.from(m));
export const acceptGeminiLine = (line: Buffer): boolean => MARKERS.some((m) => line.includes(m));

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

export interface GeminiState {
  sessionId?: string;
  projectHash?: string;
  kind?: string;
  startedAt?: number;
}

function readMetadata(o: Json, state: GeminiState): void {
  if (typeof o['sessionId'] === 'string') state.sessionId = o['sessionId'];
  if (typeof o['projectHash'] === 'string') state.projectHash = o['projectHash'];
  if (typeof o['kind'] === 'string') state.kind = o['kind'];
  const started = Date.parse(String(o['startTime']));
  if (Number.isFinite(started)) state.startedAt = started;
}

/** A `gemini` message with tokens → usage record (§8 semantics, confirmed in S7). */
function messageRecord(m: Json, state: GeminiState, fileId: string): UsageRecord | null {
  const t = obj(m['tokens']);
  if (m['type'] !== 'gemini' || !t || typeof m['id'] !== 'string') return null;
  const ts = Date.parse(String(m['timestamp']));
  if (!Number.isFinite(ts)) return null;
  const input = int(t['input']);
  const cached = int(t['cached']);
  const thoughts = int(t['thoughts']);
  const tokens = emptyTokens();
  tokens.input = Math.max(0, input - cached) + int(t['tool']);
  tokens.cacheRead = cached;
  tokens.output = int(t['output']) + thoughts;
  tokens.reasoning = thoughts;
  const sessionId = state.sessionId ?? fileId;
  return {
    id: `gemini:${sessionId}:${m['id']}`,
    ts,
    agent: 'gemini-cli',
    provider: 'google',
    rawModel: typeof m['model'] === 'string' ? m['model'] : 'unknown',
    sessionId,
    ...(state.projectHash ? { projectHash: state.projectHash } : {}),
    ...(state.startedAt ? { sessionStartedAt: state.startedAt } : {}),
    isSubagent: state.kind === 'subagent',
    tokens,
    source: 'gemini-chat',
  };
}

/**
 * One chat record (JSONL, Gemini CLI ≥ 0.60): metadata, messages (re-appended with the same id when they change)
 * and `$set` updates whose `messages` checkpoint replaces the list.
 */
export function parseGeminiLine(text: string, state: GeminiState, fileId: string): CollectedItem[] {
  let o: Json;
  try {
    o = JSON.parse(text) as Json;
  } catch {
    return [];
  }
  let messages: unknown[] = [];
  const set = obj(o['$set']);
  if (set) {
    if (Array.isArray(set['messages'])) messages = set['messages'];
  } else if (typeof o['projectHash'] === 'string' && typeof o['sessionId'] === 'string') {
    readMetadata(o, state);
    if (Array.isArray(o['messages'])) messages = o['messages'];
  } else messages = [o];
  return messages.flatMap((m) => {
    const r = obj(m) ? messageRecord(m as Json, state, fileId) : null;
    return r ? [r] : [];
  });
}

/** Legacy `*.json` session: one document rewritten in full. */
export function parseGeminiDocument(text: string, fileId: string): CollectedItem[] {
  const doc = JSON.parse(text) as Json;
  const state: GeminiState = {};
  readMetadata(doc, state);
  const messages = Array.isArray(doc['messages']) ? doc['messages'] : [];
  return messages.flatMap((m) => {
    const r = obj(m) ? messageRecord(m as Json, state, fileId) : null;
    return r ? [r] : [];
  });
}

/** `${GEMINI_CLI_HOME ?? ~}/.gemini/tmp` (chats live in `<project>/chats/**`). */
export function geminiRoots(env: NodeJS.ProcessEnv, home = homedir()): string[] {
  return [join(env['GEMINI_CLI_HOME'] || home, '.gemini', 'tmp')];
}

export const isGeminiChat = (path: string): boolean =>
  /[\\/]chats[\\/]/.test(path) && (path.endsWith('.jsonl') || path.endsWith('.json'));
