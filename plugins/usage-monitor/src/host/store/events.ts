import type { ResolvedPrice } from '../pricing/pricing-service';
import { resolveCost } from '../pricing/cost';
import { displayModel } from '../pricing/normalize-model';
import type { CostMode, UsageTokens } from '../pricing/types';
import type { UsageRecord } from '../model';
import type { Database } from './db';

export interface IngestContext {
  costMode: CostMode;
  pricingVersion: string;
  lookup: (rawModel: string) => ResolvedPrice | undefined;
  projectFor: (cwd: string | undefined, projectHash?: string) => string | null;
  terminalFor: (sessionId: string | undefined) => string | null;
}

interface EventRow {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
  reasoning_tokens: number;
  web_search_requests: number;
  reported_cost_usd: number | null;
  terminal_id: string | null;
}

/** Prepared statements for writing events (created once per database). */
export class EventWriter {
  private readonly selectEvent;
  private readonly upsertEvent;
  private readonly upsertSession;

  constructor(private readonly db: Database) {
    this.selectEvent = db.prepare(
      `SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
              reasoning_tokens, web_search_requests, reported_cost_usd, terminal_id
         FROM usage_events WHERE id = ?`,
    );
    this.upsertEvent = db.prepare(
      `INSERT INTO usage_events (id, ts, agent, provider, model, raw_model, session_id, project_id, cwd, terminal_id,
         is_subagent, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
         reasoning_tokens, web_search_requests, speed, service_tier, inference_geo, reported_cost_usd, cost_usd,
         cost_source, pricing_version, source, project_hash)
       VALUES (:id, :ts, :agent, :provider, :model, :raw_model, :session_id, :project_id, :cwd, :terminal_id,
         :is_subagent, :input, :output, :cache_read, :cache_5m, :cache_1h, :reasoning, :web, :speed, :tier, :geo,
         :reported, :cost, :cost_source, :pricing_version, :source, :project_hash)
       ON CONFLICT(id) DO UPDATE SET
         ts = max(ts, excluded.ts), model = excluded.model, raw_model = excluded.raw_model,
         project_id = excluded.project_id, terminal_id = coalesce(usage_events.terminal_id, excluded.terminal_id),
         input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
         cache_read_tokens = excluded.cache_read_tokens, cache_write_5m_tokens = excluded.cache_write_5m_tokens,
         cache_write_1h_tokens = excluded.cache_write_1h_tokens, reasoning_tokens = excluded.reasoning_tokens,
         web_search_requests = excluded.web_search_requests, speed = excluded.speed,
         service_tier = excluded.service_tier, inference_geo = excluded.inference_geo,
         reported_cost_usd = excluded.reported_cost_usd, cost_usd = excluded.cost_usd,
         cost_source = excluded.cost_source, pricing_version = excluded.pricing_version`,
    );
    this.upsertSession = db.prepare(
      `INSERT INTO sessions (session_id, agent, project_id, cwd, terminal_id, primary_source, first_event_at,
         last_event_at, last_model, project_hash, started_at)
       VALUES (:session_id, :agent, :project_id, :cwd, :terminal_id, :source, :ts, :ts, :model, :project_hash,
         :started_at)
       ON CONFLICT(session_id) DO UPDATE SET
         agent = excluded.agent,
         primary_source = coalesce(sessions.primary_source, excluded.primary_source),
         project_hash = coalesce(excluded.project_hash, sessions.project_hash),
         started_at = coalesce(sessions.started_at, excluded.started_at),
         project_id = coalesce(excluded.project_id, sessions.project_id),
         cwd = coalesce(excluded.cwd, sessions.cwd),
         terminal_id = coalesce(sessions.terminal_id, excluded.terminal_id),
         first_event_at = min(coalesce(sessions.first_event_at, excluded.first_event_at), excluded.first_event_at),
         last_event_at = max(coalesce(sessions.last_event_at, excluded.last_event_at), excluded.last_event_at),
         last_model = CASE WHEN excluded.last_event_at >= coalesce(sessions.last_event_at, 0) THEN excluded.last_model
                           ELSE sessions.last_model END`,
    );
  }

  /**
   * Inserts or merges a record: every token field keeps its maximum (one API response is written as several lines,
   * sometimes with placeholder counts first — docs/plan/08-usage-monitor.md §5.3), then the cost is recomputed.
   * Returns true when the stored row changed.
   */
  write(r: UsageRecord, ctx: IngestContext): boolean {
    const prev = this.selectEvent.get(r.id) as EventRow | undefined;
    const tokens: UsageTokens = prev
      ? {
          input: Math.max(prev.input_tokens, r.tokens.input),
          output: Math.max(prev.output_tokens, r.tokens.output),
          cacheRead: Math.max(prev.cache_read_tokens, r.tokens.cacheRead),
          cacheWrite5m: Math.max(prev.cache_write_5m_tokens, r.tokens.cacheWrite5m),
          cacheWrite1h: Math.max(prev.cache_write_1h_tokens, r.tokens.cacheWrite1h),
          reasoning: Math.max(prev.reasoning_tokens, r.tokens.reasoning),
        }
      : r.tokens;
    const web = Math.max(prev?.web_search_requests ?? 0, r.extras?.webSearchRequests ?? 0);
    const reported = r.reportedCostUsd ?? prev?.reported_cost_usd ?? null;
    if (
      prev &&
      tokens.input === prev.input_tokens &&
      tokens.output === prev.output_tokens &&
      tokens.cacheRead === prev.cache_read_tokens &&
      tokens.cacheWrite5m === prev.cache_write_5m_tokens &&
      tokens.cacheWrite1h === prev.cache_write_1h_tokens &&
      tokens.reasoning === prev.reasoning_tokens &&
      web === prev.web_search_requests &&
      reported === prev.reported_cost_usd
    )
      return false;
    const resolved = ctx.lookup(r.rawModel);
    const extras = { ...r.extras, webSearchRequests: web };
    const cost = resolveCost(ctx.costMode, { tokens, extras, price: resolved?.price, reportedUsd: reported });
    const projectId = ctx.projectFor(r.cwd, r.projectHash);
    const terminalId = prev?.terminal_id ?? ctx.terminalFor(r.sessionId);
    const model = displayModel(r.rawModel);
    this.upsertEvent.run({
      id: r.id,
      ts: r.ts,
      agent: r.agent,
      provider: resolved?.price.provider ?? r.provider,
      model,
      raw_model: r.rawModel,
      session_id: r.sessionId ?? null,
      project_id: projectId,
      cwd: r.cwd ?? null,
      terminal_id: terminalId,
      is_subagent: r.isSubagent ? 1 : 0,
      input: tokens.input,
      output: tokens.output,
      cache_read: tokens.cacheRead,
      cache_5m: tokens.cacheWrite5m,
      cache_1h: tokens.cacheWrite1h,
      reasoning: tokens.reasoning,
      web,
      speed: r.extras?.speed ?? null,
      tier: r.extras?.serviceTier ?? null,
      geo: r.extras?.inferenceGeo ?? null,
      reported,
      cost: cost.costUsd,
      cost_source: cost.costSource,
      pricing_version: resolved ? ctx.pricingVersion : null,
      source: r.source,
      project_hash: r.projectHash ?? null,
    });
    if (r.sessionId)
      this.upsertSession.run({
        session_id: r.sessionId,
        agent: r.agent,
        project_id: projectId,
        cwd: r.cwd ?? null,
        terminal_id: terminalId,
        source: r.source,
        ts: r.ts,
        model,
        project_hash: r.projectHash ?? null,
        started_at: r.sessionStartedAt ?? null,
      });
    return true;
  }
}

/** Recomputes computed costs (pricing or cost mode changed) for events since `sinceTs`; returns the count. */
export function recomputeCosts(
  db: Database,
  ctx: Pick<IngestContext, 'costMode' | 'pricingVersion' | 'lookup'>,
  sinceTs: number,
): number {
  const rows = db
    .prepare(
      `SELECT id, raw_model, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens,
              cache_write_1h_tokens, reasoning_tokens, web_search_requests, speed, service_tier, inference_geo,
              reported_cost_usd
         FROM usage_events WHERE ts >= ?`,
    )
    .all(sinceTs) as unknown as (EventRow & {
    id: string;
    raw_model: string;
    speed: string | null;
    service_tier: string | null;
    inference_geo: string | null;
  })[];
  const update = db.prepare(
    'UPDATE usage_events SET model = ?, provider = coalesce(?, provider), cost_usd = ?, cost_source = ?, pricing_version = ? WHERE id = ?',
  );
  for (const row of rows) {
    const resolved = ctx.lookup(row.raw_model);
    const cost = resolveCost(ctx.costMode, {
      tokens: {
        input: row.input_tokens,
        output: row.output_tokens,
        cacheRead: row.cache_read_tokens,
        cacheWrite5m: row.cache_write_5m_tokens,
        cacheWrite1h: row.cache_write_1h_tokens,
        reasoning: row.reasoning_tokens,
      },
      extras: {
        webSearchRequests: row.web_search_requests,
        ...(row.speed ? { speed: row.speed as 'standard' | 'fast' } : {}),
        ...(row.service_tier ? { serviceTier: row.service_tier } : {}),
        ...(row.inference_geo ? { inferenceGeo: row.inference_geo } : {}),
      },
      price: resolved?.price,
      reportedUsd: row.reported_cost_usd,
    });
    update.run(
      displayModel(row.raw_model),
      resolved?.price.provider ?? null,
      cost.costUsd,
      cost.costSource,
      resolved ? ctx.pricingVersion : null,
      row.id,
    );
  }
  return rows.length;
}
