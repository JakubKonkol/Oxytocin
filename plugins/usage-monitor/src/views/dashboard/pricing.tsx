import { useState } from 'react';
import { dateTime } from '../shared/format';
import type { StatusLineStatus } from '../shared/types';
import { useRequest, useView } from './api';

interface Rates {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}
interface Pricing {
  version: string;
  source: 'snapshot' | 'cache';
  fetchedAt: number | null;
  generatedAt: string;
  models: { model: string; source: string; perMillion: Rates }[];
  unknown: { rawModel: string; events: number; lastSeen: number }[];
}

const FIELDS: (keyof Rates)[] = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];
const LABELS: Record<keyof Rates, string> = {
  input: 'Input',
  output: 'Output',
  cacheRead: 'Cache read',
  cacheWrite5m: 'Cache write 5m',
  cacheWrite1h: 'Cache write 1h',
};

function Select({ settingKey, options, label }: { settingKey: string; options: [string, string][]; label: string }) {
  const view = useView();
  const { data, reload } = useRequest<Record<string, unknown>>('settings');
  return (
    <label className="setting">
      <span>{label}</span>
      <select
        value={typeof data?.[settingKey] === 'string' ? data[settingKey] : options[0]![0]}
        onChange={(e) => void view.request('settings.set', { key: settingKey, value: e.target.value }).then(reload)}
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Claude subscription limits through Claude Code's status line (opt-in, it changes Claude Code's settings). */
function ClaudeLimits() {
  const view = useView();
  const { data: status, reload } = useRequest<StatusLineStatus | null>('statusLine');
  // The user's choice shows right away; the backend's state follows once it has set up (or removed) the status line.
  const [pending, setPending] = useState<boolean | null>(null);
  const enabled = pending ?? status?.enabled ?? false;
  const toggle = async (enabled: boolean) => {
    setPending(enabled);
    await view.request('settings.set', { key: 'usage.claudeLimits.statusLine', value: enabled });
    // The backend then sets up (or removes) the status line and reports a change, which reloads the state again.
    reload();
  };
  let state = 'Off.';
  if (status?.error) state = `Error: ${status.error}`;
  else if (status?.enabled && status.installed)
    state = `Status line set in ${status.settingsFile} · ${
      status.observedAt
        ? `last reading ${dateTime(status.observedAt)}`
        : 'no reading yet — send a message in Claude Code'
    }`;
  else if (status?.enabled)
    state = `The status line in ${status.settingsFile} was changed — turn this off and on again.`;
  return (
    <section data-testid="usage-claude-limits">
      <h3>CLAUDE SUBSCRIPTION LIMITS</h3>
      <label className="setting">
        <span>
          <div>Show the 5-hour and weekly limits</div>
          <div className="desc">
            Claude Code passes them to its status line (Pro and Max plans). Oxytocin sets a status line command in
            Claude Code&apos;s settings.json; a status line you already have keeps working and comes back when you turn
            this off. With Claude Code billing set to Subscription, the limits replace the cost in the sidebar and the
            status bar.
          </div>
        </span>
        <input
          type="checkbox"
          aria-label="Show Claude subscription limits"
          checked={enabled}
          onChange={(e) => void toggle(e.target.checked)}
        />
      </label>
      <div className="muted" data-testid="usage-claude-limits-state">
        {state}
      </div>
    </section>
  );
}

export function PricingTab() {
  const view = useView();
  const { data, reload } = useRequest<Pricing>('pricing');
  const { data: settings, reload: reloadSettings } = useRequest<Record<string, unknown>>('settings');
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<{ model: string; rates: Record<string, string> } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const overrides = (settings?.['usage.pricing.overrides'] ?? {}) as Record<string, Rates>;

  const saveOverride = async (model: string, rates: Record<string, string> | null) => {
    const next = { ...overrides };
    if (rates) {
      const value: Record<string, number> = {};
      for (const f of FIELDS) if (rates[f] !== undefined && rates[f] !== '') value[f] = Number(rates[f]);
      next[model] = value as unknown as Rates;
    } else delete next[model];
    await view.request('settings.set', { key: 'usage.pricing.overrides', value: next });
    setEditing(null);
    reloadSettings();
    reload();
  };
  const edit = (model: string, rates?: Rates) =>
    setEditing({
      model,
      rates: Object.fromEntries(FIELDS.map((f) => [f, rates?.[f] === undefined ? '' : String(rates[f])])),
    });

  const rows = data?.models.filter((m) => m.model.includes(filter.toLowerCase())) ?? [];
  // Events without any model name (e.g. a Codex session before its first turn) cannot be priced by name.
  const unknown = data?.unknown.filter((u) => u.rawModel !== 'unknown') ?? [];
  return (
    <div data-testid="usage-pricing">
      <section>
        <Select
          settingKey="usage.costMode"
          label="Cost"
          options={[
            ['auto', 'Reported by the agent when available, else calculated'],
            ['calculate', 'Always calculate from tokens'],
            ['reported', 'Only costs reported by the agent'],
          ]}
        />
        {(['claudeCode', 'codex', 'gemini'] as const).map((a) => (
          <Select
            key={a}
            settingKey={`usage.billing.${a}`}
            label={`${a === 'claudeCode' ? 'Claude Code' : a === 'codex' ? 'Codex' : 'Gemini CLI'} billing`}
            options={[
              ['api', 'API (pay per token)'],
              ['subscription', 'Subscription (hide costs, show plan limits)'],
            ]}
          />
        ))}
        <label className="setting">
          <span>Refresh prices daily from LiteLLM</span>
          <input
            type="checkbox"
            checked={settings?.['usage.pricing.autoUpdate'] !== false}
            onChange={(e) =>
              void view
                .request('settings.set', { key: 'usage.pricing.autoUpdate', value: e.target.checked })
                .then(reloadSettings)
            }
          />
        </label>
      </section>
      <ClaudeLimits />
      {unknown.length > 0 && (
        <div className="banner" data-testid="usage-unknown-models">
          {unknown.map((u) => (
            <div key={u.rawModel}>
              Unknown model ‘{u.rawModel}’ — add its rates in Pricing{' '}
              <button type="button" className="link" onClick={() => edit(u.rawModel.toLowerCase())}>
                Add rates
              </button>
            </div>
          ))}
        </div>
      )}
      {editing && (
        <div className="form" data-testid="usage-override-form">
          <label>
            Model
            <input value={editing.model} onChange={(e) => setEditing({ ...editing, model: e.target.value })} />
          </label>
          {FIELDS.map((f) => (
            <label key={f}>
              {LABELS[f]} ($/1M)
              <input
                value={editing.rates[f] ?? ''}
                inputMode="decimal"
                aria-label={`${LABELS[f]} per million tokens`}
                onChange={(e) => setEditing({ ...editing, rates: { ...editing.rates, [f]: e.target.value } })}
              />
            </label>
          ))}
          <button
            type="button"
            disabled={
              !(
                Number(editing.rates['input']) >= 0 &&
                Number(editing.rates['output']) >= 0 &&
                editing.rates['input'] &&
                editing.rates['output']
              )
            }
            onClick={() => void saveOverride(editing.model.trim().toLowerCase(), editing.rates)}
          >
            Save rates
          </button>
          <button type="button" onClick={() => setEditing(null)}>
            Cancel
          </button>
        </div>
      )}
      <div className="toolbar">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter models"
          aria-label="Filter models"
        />
        <span className="muted">
          {data
            ? `${data.source === 'cache' ? 'Downloaded' : 'Built-in'} prices ${data.version}${data.fetchedAt ? ` · checked ${dateTime(data.fetchedAt)}` : ''}`
            : ''}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            void view.request('pricing.refresh').finally(() => {
              setRefreshing(false);
              reload();
            });
          }}
        >
          {refreshing ? 'Refreshing…' : 'Refresh now'}
        </button>
        <button type="button" onClick={() => edit('')}>
          Add model
        </button>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>Model</th>
            {FIELDS.map((f) => (
              <th key={f} className="num">
                {LABELS[f]}
              </th>
            ))}
            <th>Source</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.model}>
              <td>{m.model}</td>
              {FIELDS.map((f) => (
                <td key={f} className="num">
                  {m.perMillion[f] === undefined ? '—' : `$${m.perMillion[f]}`}
                </td>
              ))}
              <td>{m.source}</td>
              <td>
                <button type="button" className="link" onClick={() => edit(m.model, m.perMillion)}>
                  Edit
                </button>
                {m.source === 'override' && (
                  <>
                    {' · '}
                    <button type="button" className="link" onClick={() => void saveOverride(m.model, null)}>
                      Reset
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
