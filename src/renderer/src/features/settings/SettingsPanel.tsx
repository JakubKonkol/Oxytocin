import type { IDockviewPanelProps } from 'dockview-react';
import { AlertTriangle, FileJson, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { SettingsProblem } from '@shared/domain/settings';
import { formatSettingInput, isModified, parseSettingInput, type SettingDescriptor } from '@shared/domain/settings-ui';
import type { TerminalProfile } from '@shared/domain/terminal-profile';
import { cn } from '../../lib/cn';
import { registerCommand } from '../../lib/commands';
import { ipc } from '../../lib/ipc-client';
import { currentPlatform } from '../../lib/platform';
import { usePluginsStore } from '../../stores/plugins-store';
import { useSettingsStore } from '../../stores/settings-store';
import { Button } from '../../ui/Button';
import { IconButton } from '../../ui/IconButton';
import { notify } from '../../ui/Toast';
import { getActiveWorkspace } from '../layout/workspace-registry';
import {
  allDescriptors,
  filterDescriptors,
  type PluginConfiguration,
  sectionsOf,
  settingsProblems,
  validateValue,
  valueOf,
} from './settings-model';

export const SETTINGS_PANEL_ID = 'settings-editor';

/** Opens (or focuses) the Settings editor; `query` pre-fills the search (e.g. a problem's key). */
export function openSettingsEditor(query?: string): void {
  const workspace = getActiveWorkspace();
  if (!workspace) {
    notify('info', 'Open a project to edit settings');
    return;
  }
  if (query !== undefined) pendingQuery = query;
  const existing = workspace.api.getPanel(SETTINGS_PANEL_ID);
  if (existing) {
    existing.api.setActive();
    if (query !== undefined) window.dispatchEvent(new CustomEvent('oxy:settings-query', { detail: query }));
    return;
  }
  workspace.api.addPanel({ id: SETTINGS_PANEL_ID, component: 'settings', title: 'Settings' });
}
let pendingQuery: string | undefined;

async function openSettingsFile(): Promise<void> {
  try {
    await ipc.invoke('settings:openFile');
  } catch (e) {
    notify('error', 'Could not open settings.json', { description: e instanceof Error ? e.message : String(e) });
  }
}

export function registerSettingsCommands(): void {
  registerCommand({
    id: 'workbench.openSettings',
    title: 'Preferences: Open Settings',
    run: () => openSettingsEditor(),
  });
  registerCommand({
    id: 'workbench.openSettingsFile',
    title: 'Preferences: Open Settings (JSON)',
    run: () => openSettingsFile(),
  });
}

/** Startup check (09 §3.1): invalid values fall back to defaults; a toast offers the settings UI. */
export async function reportSettingsProblems(): Promise<void> {
  const problems = await ipc.invoke('settings:problems');
  if (problems.length === 0) return;
  notify('warning', `settings.json has ${problems.length} invalid value${problems.length === 1 ? '' : 's'}`, {
    description: 'The defaults are used instead.',
    action: { label: 'Open Settings', onClick: () => openSettingsEditor('@problems') },
  });
}

async function write(key: string, value: unknown): Promise<void> {
  try {
    await ipc.invoke('settings:update', { [key]: value });
  } catch (e) {
    notify('error', 'Could not save the setting', { description: e instanceof Error ? e.message : String(e) });
  }
}

function usePluginConfigurations(): PluginConfiguration[] {
  const configuration = usePluginsStore((s) => s.contributions.configuration);
  const plugins = usePluginsStore((s) => s.plugins);
  return useMemo(
    () =>
      configuration.map((c) => ({
        pluginId: c.pluginId,
        pluginName: plugins.find((p) => p.id === c.pluginId)?.displayName ?? c.pluginId,
        properties: c.properties,
      })),
    [configuration, plugins],
  );
}

const inputClass =
  'h-7 rounded-control border border-line bg-input px-2 text-ui text-fg placeholder:text-fg-muted disabled:opacity-60';

function TextControl({
  d,
  value,
  onCommit,
  multiline,
  placeholder,
}: {
  d: SettingDescriptor;
  value: unknown;
  onCommit: (text: string) => void;
  multiline?: boolean;
  placeholder?: string;
}) {
  const formatted = formatSettingInput(d, value);
  const [text, setText] = useState(formatted);
  const [shown, setShown] = useState(formatted);
  // A new value from settings.json (external edit, reset) replaces the draft.
  if (formatted !== shown) {
    setShown(formatted);
    setText(formatted);
  }
  const commit = () => {
    if (text !== formatted) onCommit(text);
  };
  if (multiline)
    return (
      <textarea
        data-testid="setting-control"
        value={text}
        rows={Math.min(8, Math.max(3, text.split('\n').length))}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        className={cn(inputClass, 'h-auto w-full max-w-[520px] py-1 font-mono text-small')}
      />
    );
  return (
    <input
      data-testid="setting-control"
      type={d.control === 'number' || d.control === 'integer' ? 'number' : 'text'}
      value={text}
      placeholder={placeholder}
      {...(d.minimum !== undefined ? { min: d.minimum } : {})}
      {...(d.maximum !== undefined ? { max: d.maximum } : {})}
      step={d.control === 'integer' ? 1 : 'any'}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setText(formatted);
      }}
      className={cn(
        inputClass,
        d.control === 'string' || d.control === 'nullableString' ? 'w-full max-w-[520px]' : 'w-32',
      )}
    />
  );
}

function ProfileSelect({ value, onChange }: { value: unknown; onChange: (v: string | null) => void }) {
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  useEffect(() => {
    let cancelled = false;
    void ipc.invoke('terminals:profiles').then((p) => !cancelled && setProfiles(p));
    return () => {
      cancelled = true;
    };
  }, []);
  const current = typeof value === 'string' ? value : '';
  return (
    <select
      data-testid="setting-control"
      value={current}
      onChange={(e) => onChange(e.target.value || null)}
      className={cn(inputClass, 'w-64')}
    >
      <option value="">Automatic</option>
      {profiles.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
      {current && !profiles.some((p) => p.id === current) && <option value={current}>{current} (not found)</option>}
    </select>
  );
}

function Control({ d, value, onChange }: { d: SettingDescriptor; value: unknown; onChange: (value: unknown) => void }) {
  if (d.readOnly || d.control === 'json')
    return (
      <div className="flex items-start gap-2">
        <pre className="max-h-40 max-w-[520px] flex-1 overflow-auto rounded-control border border-line-subtle bg-input px-2 py-1 font-mono text-small text-fg-secondary">
          {JSON.stringify(value, null, 2)}
        </pre>
        {!d.readOnly && (
          <Button size="sm" variant="ghost" onClick={() => void openSettingsFile()}>
            Edit in settings.json
          </Button>
        )}
      </div>
    );
  if (d.key.startsWith('terminal.defaultProfile.')) return <ProfileSelect value={value} onChange={onChange} />;
  switch (d.control) {
    case 'boolean':
      return (
        <label className="flex items-center gap-2 text-fg-secondary">
          <input
            data-testid="setting-control"
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            className="accent-(--accent)"
          />
          {value === true ? 'On' : 'Off'}
        </label>
      );
    case 'enum': {
      const index = d.enumValues?.findIndex((e) => JSON.stringify(e.value) === JSON.stringify(value)) ?? -1;
      return (
        <select
          data-testid="setting-control"
          value={index}
          onChange={(e) => onChange(d.enumValues![Number(e.target.value)]!.value)}
          className={cn(inputClass, 'w-64')}
        >
          {index < 0 && <option value={-1}>{JSON.stringify(value)}</option>}
          {d.enumValues!.map((e, i) => (
            <option key={i} value={i} title={e.description}>
              {e.label}
            </option>
          ))}
        </select>
      );
    }
    default:
      return (
        <TextControl
          d={d}
          value={value}
          multiline={d.control === 'stringList'}
          {...(d.control === 'nullableString' ? { placeholder: 'Automatic' } : {})}
          onCommit={(text) => {
            const parsed = parseSettingInput(d, text);
            if ('error' in parsed) {
              notify('warning', `${d.title}: ${parsed.error}`);
              return;
            }
            onChange(parsed.value);
          }}
        />
      );
  }
}

function SettingRow({
  d,
  value,
  problem,
  configurations,
}: {
  d: SettingDescriptor;
  value: unknown;
  problem: SettingsProblem | undefined;
  configurations: PluginConfiguration[];
}) {
  const modified = isModified(d, value);
  const change = (next: unknown) => {
    const error = validateValue(d, next, configurations);
    if (error) {
      notify('warning', `${d.title}: ${error}`);
      return;
    }
    void write(d.key, next);
  };
  return (
    <div
      data-testid="setting-row"
      data-key={d.key}
      data-modified={modified ? 'true' : 'false'}
      className={cn('group border-l-2 py-2.5 pr-4 pl-3', modified ? 'border-accent' : 'border-transparent')}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-medium text-fg">{d.title}</span>
        <span className="font-mono text-small text-fg-muted">{d.key}</span>
        {(modified || problem) && !d.readOnly && (
          <IconButton
            data-testid="setting-reset"
            label="Reset to default"
            icon={<RotateCcw size={11} />}
            className="size-5 opacity-60 group-hover:opacity-100"
            onClick={() => void write(d.key, null)}
          />
        )}
      </div>
      {d.description && <p className="mt-0.5 max-w-[720px] text-small text-fg-secondary">{d.description}</p>}
      {problem && (
        <p data-testid="setting-problem" className="mt-1 flex items-center gap-1 text-small text-danger">
          <AlertTriangle size={11} /> Invalid value in settings.json ({problem.message}); the default is used.
        </p>
      )}
      <div className="mt-1.5">
        <Control d={d} value={value} onChange={change} />
      </div>
    </div>
  );
}

/** Settings UI: forms generated from the core and plugin schemas; writes settings.json. */
export function SettingsPanel(_props: IDockviewPanelProps) {
  const settings = useSettingsStore((s) => s.settings) as Record<string, unknown> | null;
  const configurations = usePluginConfigurations();
  const [query, setQuery] = useState(() => {
    const q = pendingQuery ?? '';
    pendingQuery = undefined;
    return q;
  });
  const [section, setSection] = useState<string | null>(null);
  const [coreProblems, setCoreProblems] = useState<SettingsProblem[]>([]);

  useEffect(() => {
    const onQuery = (e: Event) => setQuery((e as CustomEvent<string>).detail);
    window.addEventListener('oxy:settings-query', onQuery);
    return () => window.removeEventListener('oxy:settings-query', onQuery);
  }, []);
  // Problems are re-read whenever settings.json changes.
  useEffect(() => {
    let cancelled = false;
    void ipc.invoke('settings:problems').then((p) => !cancelled && setCoreProblems(p));
    return () => {
      cancelled = true;
    };
  }, [settings]);

  const descriptors = useMemo(() => allDescriptors(currentPlatform(), configurations), [configurations]);
  const sections = useMemo(() => sectionsOf(descriptors), [descriptors]);
  if (!settings) return null;
  const problems = settingsProblems(coreProblems, configurations, settings);
  const problemFor = new Map(problems.map((p) => [p.key, p]));

  const problemsOnly = query.split(/\s+/).includes('@problems');
  const text = query
    .split(/\s+/)
    .filter((t) => t !== '@problems')
    .join(' ');
  let visible = filterDescriptors(descriptors, text, settings);
  if (problemsOnly) visible = visible.filter((d) => problemFor.has(d.key));
  const searching = query.trim() !== '';
  if (!searching && section) visible = visible.filter((d) => d.section === section);
  const groups = sectionsOf(visible).map((s) => ({ section: s, items: visible.filter((d) => d.section === s) }));

  return (
    <div data-testid="settings-panel" className="flex h-full min-h-0 flex-col bg-card text-ui">
      <div className="flex h-10 flex-none items-center gap-2 border-b border-line-subtle px-4">
        <span className="font-medium text-fg">Settings</span>
        <input
          data-testid="settings-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search settings (@modified, @problems)"
          className={cn(inputClass, 'ml-2 min-w-0 flex-1')}
        />
        <Button size="sm" variant="ghost" data-testid="settings-open-file" onClick={() => void openSettingsFile()}>
          <FileJson size={12} /> Open settings.json
        </Button>
      </div>
      {problems.length > 0 && (
        <button
          type="button"
          data-testid="settings-problems"
          onClick={() => setQuery('@problems')}
          className="flex flex-none items-center gap-1.5 border-b border-line-subtle bg-danger/10 px-4 py-1.5 text-left text-small text-danger"
        >
          <AlertTriangle size={12} />
          {problems.length} invalid value{problems.length === 1 ? '' : 's'} in settings.json — the defaults are used.
          Show
        </button>
      )}
      <div className="flex min-h-0 flex-1">
        <nav className="w-44 flex-none overflow-auto border-r border-line-subtle py-2" aria-label="Settings sections">
          {[null, ...sections].map((s) => (
            <button
              key={s ?? 'all'}
              type="button"
              data-testid="settings-section"
              data-section={s ?? 'All'}
              onClick={() => {
                setSection(s);
                setQuery('');
              }}
              className={cn(
                'block w-full truncate px-4 py-1 text-left text-fg-secondary hover:text-fg',
                !searching && section === s && 'bg-accent-muted text-fg',
              )}
            >
              {s ?? 'All settings'}
            </button>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-2">
          {groups.map((g) => (
            <section key={g.section} data-testid="settings-group" data-section={g.section} className="mb-4">
              <h2 className="oxy-label border-b border-line-subtle py-1.5">{g.section}</h2>
              {g.items.map((d) => (
                <SettingRow
                  key={d.key}
                  d={d}
                  value={valueOf(d, settings)}
                  problem={problemFor.get(d.key)}
                  configurations={configurations}
                />
              ))}
            </section>
          ))}
          {groups.length === 0 && <div className="py-3 text-fg-muted">No matching settings.</div>}
        </div>
      </div>
    </div>
  );
}
