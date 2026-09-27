import { useState } from 'react';
import { dateTime } from '../shared/format';
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
              ['subscription', 'Subscription (show ≈ API-equivalent cost)'],
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
