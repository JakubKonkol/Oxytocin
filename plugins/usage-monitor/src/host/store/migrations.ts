/**
 * Schema migrations (docs/plan/08-usage-monitor.md §11). Kept as TypeScript strings instead of `.sql` files so the
 * plugin bundles into one worker file; append new migrations, never edit released ones.
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'init',
    sql: `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  agent TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  raw_model TEXT NOT NULL,
  session_id TEXT,
  project_id TEXT,
  cwd TEXT,
  terminal_id TEXT,
  is_subagent INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  web_search_requests INTEGER NOT NULL DEFAULT 0,
  speed TEXT, service_tier TEXT, inference_geo TEXT,
  reported_cost_usd REAL,
  cost_usd REAL,
  cost_source TEXT NOT NULL,
  pricing_version TEXT,
  source TEXT NOT NULL
);
CREATE INDEX ix_events_ts ON usage_events(ts);
CREATE INDEX ix_events_project_ts ON usage_events(project_id, ts);
CREATE INDEX ix_events_session ON usage_events(session_id);
CREATE INDEX ix_events_cwd ON usage_events(cwd);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  project_id TEXT, cwd TEXT, terminal_id TEXT,
  title TEXT,
  primary_source TEXT,
  first_event_at INTEGER, last_event_at INTEGER,
  last_model TEXT,
  reported_cost_usd REAL
);
CREATE INDEX ix_sessions_last ON sessions(last_event_at);

CREATE TABLE ingest_cursors (
  path TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  file_id TEXT,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  offset INTEGER NOT NULL,
  state TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE agent_limits (
  agent TEXT NOT NULL, window TEXT NOT NULL,
  used_percent REAL, window_minutes INTEGER, resets_at INTEGER, observed_at INTEGER NOT NULL,
  PRIMARY KEY (agent, window)
);

CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_ref TEXT,
  period TEXT NOT NULL,
  metric TEXT NOT NULL,
  amount REAL NOT NULL,
  thresholds TEXT NOT NULL DEFAULT '[0.8,1.0]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE budget_alerts (
  budget_id TEXT NOT NULL, period_key TEXT NOT NULL, threshold REAL NOT NULL, fired_at INTEGER NOT NULL,
  PRIMARY KEY (budget_id, period_key, threshold)
);
`,
  },
];
