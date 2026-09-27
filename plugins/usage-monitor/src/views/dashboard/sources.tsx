import { dateTime, SOURCE_NAMES } from '../shared/format';
import type { SourceStatus } from '../shared/types';
import { useRequest, useView } from './api';

function Toggle({ settingKey, label, description }: { settingKey: string; label: string; description?: string }) {
  const view = useView();
  const { data, reload } = useRequest<Record<string, unknown>>('settings');
  const defaults: Record<string, boolean> = {
    'usage.liveTelemetry.claudeCode': false,
    'usage.liveTelemetry.gemini': false,
  };
  const value = (data?.[settingKey] as boolean | undefined) ?? defaults[settingKey] ?? true;
  return (
    <label className="setting">
      <span>
        <div>{label}</div>
        {description && <div className="desc">{description}</div>}
      </span>
      <input
        type="checkbox"
        checked={value}
        aria-label={label}
        onChange={(e) => void view.request('settings.set', { key: settingKey, value: e.target.checked }).then(reload)}
      />
    </label>
  );
}

const SETTING: Record<string, string> = {
  'claude-jsonl': 'usage.sources.claudeCode',
  'codex-rollout': 'usage.sources.codex',
  'gemini-chat': 'usage.sources.gemini',
};

export function SourcesTab() {
  const { data } = useRequest<SourceStatus>('sources');
  return (
    <div data-testid="usage-sources">
      <section>
        <h3>AGENT LOGS</h3>
        {data?.collectors.map((c) => (
          <div key={c.source} className="detail">
            <Toggle settingKey={SETTING[c.source]!} label={SOURCE_NAMES[c.source]!} />
            {c.roots.map((r) => (
              <div key={r.path} className="mono muted">
                {r.exists ? '✓' : '✗'} {r.path}
              </div>
            ))}
            <div className="muted">
              {c.files} files · last event {c.lastEventAt ? dateTime(c.lastEventAt) : '—'}
              {c.parseErrors > 0 ? ` · ${c.parseErrors} unreadable lines` : ''}
            </div>
          </div>
        ))}
        <div className="muted" style={{ marginTop: 8 }}>
          Oxytocin reads your agents&apos; local logs to calculate costs. Only usage metadata is stored — nothing leaves
          your computer. Claude Code transcripts miss a few internal requests (e.g. context compaction); live telemetry
          reports them.
        </div>
      </section>
      <section>
        <h3>LIVE TELEMETRY (OPENTELEMETRY)</h3>
        {data?.userOtelConfig && (
          <div className="banner">
            Your OpenTelemetry configuration was detected — live mode for Claude Code is off, using logs instead. (
            {data.userOtelConfig})
          </div>
        )}
        <Toggle
          settingKey="usage.liveTelemetry.claudeCode"
          label="Claude Code"
          description="Adds OTEL_* variables to Claude Code terminals. Other OpenTelemetry programs started there would report to Oxytocin too."
        />
        <Toggle
          settingKey="usage.liveTelemetry.gemini"
          label="Gemini CLI"
          description="Adds GEMINI_TELEMETRY_* variables to Gemini CLI terminals."
        />
        <div className="muted">
          {data?.otlp
            ? `Receiver on 127.0.0.1:${data.otlp.port} · ${data.otlp.packets} exports received${data.otlp.lastPacketAt ? `, last ${dateTime(data.otlp.lastPacketAt)}` : ''}${data.otlp.rejected ? ` · ${data.otlp.rejected} rejected` : ''}`
            : 'Receiver off.'}
        </div>
      </section>
    </div>
  );
}
