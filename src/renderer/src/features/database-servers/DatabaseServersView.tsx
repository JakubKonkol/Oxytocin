import { CheckCircle2, Database, Loader2, Plus, Radar, RotateCcw, Save, Trash2, XCircle } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useEffect, useState } from 'react';
import {
  addDatabases,
  type DatabaseServer,
  discoveryDatabase,
  type DiscoveryResult,
  newServer,
  SERVER_ENGINES,
  validateServers,
} from '@shared/domain/database-servers';
import {
  type DatabaseEngine,
  ENGINE_INFO,
  RESOURCE_ENVIRONMENTS,
  secretStatusKey,
  type TlsMode,
} from '@shared/domain/project-resources';
import { cn } from '../../lib/cn';
import { ipc } from '../../lib/ipc-client';
import { confirmDialog } from '../../stores/dialog-store';
import { Button } from '../../ui/Button';
import { notify } from '../../ui/Toast';
import { type SecretEdits, secretState } from '../projects/resources-model';
import { Check, Field, input, ResourceList, SecretInput, Section } from '../projects/settings/controls';
import { describeServer, newlyFound, sameServers, serverSecretChanges, typedPassword } from './servers-model';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A change to a server; `undefined` removes an optional field. */
type ServerPatch = { [K in keyof DatabaseServer]?: DatabaseServer[K] | undefined };

interface Loaded {
  servers: DatabaseServer[];
  stored: string[];
  usage: Record<string, string[]>;
}

function Discovery({
  server,
  result,
  busy,
  onDiscover,
  onAdd,
}: {
  server: DatabaseServer;
  result: DiscoveryResult | undefined;
  busy: boolean;
  onDiscover: () => void;
  onAdd: (names: string[]) => void;
}) {
  const [showSystem, setShowSystem] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const found = newlyFound(result, server, showSystem);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" data-testid="dbserver-discover" disabled={busy} onClick={onDiscover}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Radar size={12} />} Discover databases
        </Button>
        <span className="text-small text-fg-muted">
          Connects with the login above and lists the databases it can use.
        </span>
      </div>
      {result && (
        <div
          data-testid="dbserver-discover-result"
          data-ok={result.ok}
          role="status"
          className={cn(
            'flex flex-col gap-1.5 rounded-control border px-2 py-1.5 text-small',
            result.ok ? 'border-success' : 'border-danger',
          )}
        >
          <div className="flex items-center gap-2">
            {result.ok ? (
              <CheckCircle2 size={14} className="flex-none text-success" />
            ) : (
              <XCircle size={14} className="flex-none text-danger" />
            )}
            <span className="font-medium text-fg">
              {result.ok
                ? `Connected — ${result.serverVersion ?? ''} · ${result.databases.length} database${result.databases.length === 1 ? '' : 's'}`
                : 'Discovery failed'}
            </span>
            {result.latencyMs !== undefined && <span className="text-fg-muted">{result.latencyMs} ms</span>}
          </div>
          {!result.ok && result.error && (
            <div className="whitespace-pre-wrap break-words text-fg-secondary">{result.error.message}</div>
          )}
          {result.note && <div className="text-fg-secondary">{result.note}</div>}
          {result.ok && (
            <>
              <div className="flex items-center gap-3">
                <Check checked={showSystem} onChange={setShowSystem} testId="dbserver-show-system">
                  Show system databases
                </Check>
                <span className="flex-1" />
                <Button
                  size="sm"
                  data-testid="dbserver-add-picked"
                  disabled={![...picked].some((n) => found.some((f) => f.name === n))}
                  onClick={() => {
                    onAdd(found.filter((f) => picked.has(f.name)).map((f) => f.name));
                    setPicked(new Set());
                  }}
                >
                  Add selected
                </Button>
                <Button
                  size="sm"
                  data-testid="dbserver-add-all"
                  disabled={found.length === 0}
                  onClick={() => {
                    onAdd(found.map((f) => f.name));
                    setPicked(new Set());
                  }}
                >
                  Add all ({found.length})
                </Button>
              </div>
              {found.length === 0 && <div className="text-fg-muted">Every database found is on the list below.</div>}
              <div className="flex max-h-48 flex-col gap-0.5 overflow-auto">
                {found.map((f) => (
                  <label
                    key={f.name}
                    data-testid="dbserver-found-item"
                    data-name={f.name}
                    className="flex items-center gap-2 text-fg-secondary"
                  >
                    <input
                      type="checkbox"
                      checked={picked.has(f.name)}
                      onChange={(e) =>
                        setPicked((p) => {
                          const next = new Set(p);
                          if (e.target.checked) next.add(f.name);
                          else next.delete(f.name);
                          return next;
                        })
                      }
                    />
                    <span className="font-mono">{f.name}</span>
                    {f.system && <span className="text-fg-muted">system</span>}
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ServerForm({
  server,
  set,
  remove,
  stored,
  edits,
  setEdits,
  usage,
}: {
  server: DatabaseServer;
  set: (patch: ServerPatch) => void;
  remove: () => void;
  stored: readonly string[];
  edits: SecretEdits;
  setEdits: (fn: (e: SecretEdits) => SecretEdits) => void;
  usage: string[];
}) {
  const [result, setResult] = useState<DiscoveryResult>();
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const info = ENGINE_INFO[server.engine];
  const option = (key: string) => server.options[key] ?? '';
  const setOption = (key: string, value: string) => {
    const options = { ...server.options };
    if (value.trim()) options[key] = value.trim();
    else delete options[key];
    set({ options });
  };
  const passwordKey = secretStatusKey(server.id, 'password');
  const discover = () => {
    setBusy(true);
    setResult(undefined);
    const password = typedPassword(edits, server.id);
    ipc
      .invoke('dbServers:discover', { server, ...(password !== undefined ? { password } : {}) })
      .then(setResult, (e: unknown) =>
        setResult({ ok: false, databases: [], error: { kind: 'other', message: errorText(e) } }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <div data-testid="dbserver-form" className="flex min-w-0 flex-1 flex-col gap-3 pr-1">
      <Section
        title="Server"
        action={
          <Button size="sm" variant="ghost" data-testid="dbserver-remove" onClick={remove}>
            <Trash2 size={12} /> Remove
          </Button>
        }
      >
        <div className="grid grid-cols-[1fr_140px_140px] gap-2">
          <Field label="Name" hint="Shown to agents: FIRMA_1/WMS_DB.">
            <input
              data-testid="dbserver-name"
              value={server.name}
              onChange={(e) => set({ name: e.target.value })}
              className={input}
            />
          </Field>
          <Field label="Engine">
            <select
              data-testid="dbserver-engine"
              value={server.engine}
              onChange={(e) => {
                const engine = e.target.value as DatabaseEngine;
                const fresh = newServer([], engine);
                set({ engine, port: undefined, database: undefined, options: {}, user: fresh.user, tls: fresh.tls });
              }}
              className={input}
            >
              {SERVER_ENGINES.map((e) => (
                <option key={e} value={e}>
                  {ENGINE_INFO[e].label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Environment" hint="Linked databases start with it.">
            <select
              data-testid="dbserver-environment"
              value={server.environment}
              onChange={(e) => set({ environment: e.target.value as DatabaseServer['environment'] })}
              className={input}
            >
              {RESOURCE_ENVIRONMENTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-[1fr_96px] gap-2">
          <Field label="Host" hint="Name or IP address, e.g. 10.10.10.15">
            <input
              data-testid="dbserver-host"
              value={server.host}
              onChange={(e) => set({ host: e.target.value })}
              className={input}
            />
          </Field>
          <Field label="Port">
            <input
              data-testid="dbserver-port"
              inputMode="numeric"
              value={server.port ?? ''}
              placeholder={String(info.defaultPort ?? '')}
              onChange={(e) => {
                const port = Number(e.target.value);
                set({ port: e.target.value && Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined });
              }}
              className={input}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {info.user && (
            <Field label="User">
              <input
                data-testid="dbserver-user"
                value={server.user ?? ''}
                placeholder={info.defaultUser ?? ''}
                onChange={(e) => set({ user: e.target.value || undefined })}
                className={input}
              />
            </Field>
          )}
          <SecretInput
            label="Password"
            testId="dbserver-password"
            state={secretState(stored, edits, server.id, 'password')}
            onSet={(value) => setEdits((e) => ({ ...e, [passwordKey]: { value } }))}
            onRemove={() => setEdits((e) => ({ ...e, [passwordKey]: { remove: true } }))}
            onReset={() =>
              setEdits((e) => {
                const next = { ...e };
                delete next[passwordKey];
                return next;
              })
            }
            hint="Stored encrypted. A read-only login is recommended."
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          {server.engine !== 'redis' && (
            <Field
              label={server.engine === 'oracle' ? 'Service name' : 'Connect to database'}
              hint={
                server.engine === 'oracle'
                  ? 'Discovery connects to this service, e.g. FREEPDB1.'
                  : 'Used for discovery; empty: the default.'
              }
            >
              <input
                data-testid="dbserver-database"
                value={server.database ?? ''}
                placeholder={discoveryDatabase(server.engine) ?? ''}
                onChange={(e) => set({ database: e.target.value || undefined })}
                className={input}
              />
            </Field>
          )}
          <Field label="TLS">
            <select
              data-testid="dbserver-tls"
              value={server.tls?.mode ?? 'prefer'}
              onChange={(e) =>
                set({
                  tls: {
                    mode: e.target.value as TlsMode,
                    trustServerCertificate: server.tls?.trustServerCertificate ?? false,
                    ...(server.tls?.caPath ? { caPath: server.tls.caPath } : {}),
                  },
                })
              }
              className={input}
            >
              <option value="disable">Disable</option>
              <option value="prefer">
                {server.engine === 'sqlserver' ? 'Encrypt' : 'Prefer (when the server offers it)'}
              </option>
              <option value="require">Require (not verified)</option>
              <option value="verify">Require and verify the certificate</option>
            </select>
          </Field>
        </div>
        {server.engine === 'sqlserver' && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Instance name" hint="e.g. SQLEXPRESS (SQL Browser must run)">
                <input
                  value={option('instanceName')}
                  onChange={(e) => setOption('instanceName', e.target.value)}
                  className={input}
                />
              </Field>
              <Field label="Windows domain (NTLM)" hint="With a user and password; empty for SQL logins.">
                <input
                  value={option('domain')}
                  onChange={(e) => setOption('domain', e.target.value)}
                  className={input}
                />
              </Field>
            </div>
            <Check
              testId="dbserver-trust-certificate"
              checked={server.tls?.trustServerCertificate ?? false}
              onChange={(v) => set({ tls: { mode: server.tls?.mode ?? 'prefer', trustServerCertificate: v } })}
            >
              Trust server certificate (self-signed certificates on internal servers)
            </Check>
          </>
        )}
        {server.engine === 'mongodb' && (
          <Field label="Authentication database" hint="authSource, e.g. admin">
            <input
              value={option('authSource')}
              onChange={(e) => setOption('authSource', e.target.value)}
              className={input}
            />
          </Field>
        )}
      </Section>

      <Section title="Databases">
        <Discovery
          server={server}
          result={result}
          busy={busy}
          onDiscover={discover}
          onAdd={(names) => set({ databases: addDatabases(server, names).databases })}
        />
        <div className="flex flex-col gap-1" data-testid="dbserver-db-list">
          {server.databases.length === 0 && (
            <div className="text-small text-fg-muted">No databases yet: discover them, or add one by name.</div>
          )}
          {server.databases.map((d) => (
            <div
              key={d.name}
              data-testid="dbserver-db-item"
              data-name={d.name}
              className="grid grid-cols-[minmax(120px,220px)_1fr_auto] items-center gap-2"
            >
              <span className="flex items-center gap-1.5 truncate font-mono text-ui text-fg">
                <Database size={12} className="flex-none text-fg-muted" />
                {d.name}
              </span>
              <input
                value={d.description ?? ''}
                maxLength={2000}
                placeholder="Notes for agents (optional)"
                onChange={(e) =>
                  set({
                    databases: server.databases.map((x) =>
                      x.name === d.name
                        ? { name: x.name, ...(e.target.value ? { description: e.target.value } : {}) }
                        : x,
                    ),
                  })
                }
                className={input}
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove ${d.name}`}
                onClick={() => set({ databases: server.databases.filter((x) => x.name !== d.name) })}
              >
                <Trash2 size={12} />
              </Button>
            </div>
          ))}
          <div className="flex gap-1.5">
            <input
              data-testid="dbserver-db-new"
              value={newName}
              placeholder="Add a database by name"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newName.trim()) {
                  set({ databases: addDatabases(server, [newName.trim()]).databases });
                  setNewName('');
                }
              }}
              className={cn(input, 'max-w-[320px] font-mono')}
            />
            <Button
              size="sm"
              data-testid="dbserver-db-add"
              disabled={!newName.trim()}
              onClick={() => {
                set({ databases: addDatabases(server, [newName.trim()]).databases });
                setNewName('');
              }}
            >
              <Plus size={12} /> Add
            </Button>
          </div>
        </div>
        <p className="text-small text-fg-muted" data-testid="dbserver-usage">
          {usage.length
            ? `Linked in: ${usage.join(', ')}.`
            : 'Not linked to a project yet: Project settings → Databases → Add from servers.'}
        </p>
      </Section>
    </div>
  );
}

/** Settings → Database Servers: servers configured once, their databases linked to projects as needed. */
export function DatabaseServersView() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<DatabaseServer[]>([]);
  const [edits, setEdits] = useState<SecretEdits>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () =>
    ipc.invoke('dbServers:get').then(
      (r) => {
        setLoaded({ servers: r.servers, stored: r.secrets.stored, usage: r.usage });
        setDraft(r.servers);
        setEdits({});
      },
      (e: unknown) => notify('error', 'Could not load the database servers', { description: errorText(e) }),
    );
  useEffect(() => {
    void load();
  }, []);

  if (!loaded) return <div className="py-3 text-fg-muted">Loading…</div>;
  const dirty = !sameServers(draft, loaded.servers) || serverSecretChanges(draft, edits).length > 0;
  const problems = validateServers(draft);
  const current = draft.find((s) => s.id === selected) ?? draft[0];
  const update = (id: string, patch: ServerPatch) =>
    setDraft((list) =>
      list.map((s) => {
        if (s.id !== id) return s;
        const next: Record<string, unknown> = { ...s, ...patch };
        for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
        return next as DatabaseServer;
      }),
    );
  const add = (engine: DatabaseEngine) => {
    const server = newServer(draft, engine);
    setDraft((list) => [...list, server]);
    setSelected(server.id);
  };
  const save = async () => {
    setSaving(true);
    try {
      await ipc.invoke('dbServers:save', { servers: draft, secrets: serverSecretChanges(draft, edits) });
      notify('success', 'Database servers saved');
      await load();
    } catch (e) {
      notify('error', 'Could not save the database servers', { description: errorText(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="dbservers-view" className="mb-4 flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="oxy-label border-b border-line-subtle py-1.5">Database Servers</h2>
        <p className="max-w-[760px] text-small text-fg-muted">
          Add each server once — its address, login and password — and pick its databases (Oxytocin can discover them).
          Then link the databases a project needs in <em>Project settings → Databases → Add from servers</em>: agents of
          that project see them grouped by server, e.g. FIRMA_1/WMS_DB and FIRMA_2/WMS_DB, and use them through
          Oxytocin's tools with the access you allow per project.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Button size="sm" data-testid="dbservers-add">
              <Plus size={12} /> Add server
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              sideOffset={4}
              className="z-[60] w-72 rounded-card border border-line bg-elevated p-1 shadow-elevated"
            >
              {SERVER_ENGINES.map((e) => (
                <DropdownMenu.Item
                  key={e}
                  data-testid={`dbservers-add-${e}`}
                  onSelect={() => add(e)}
                  className="flex cursor-default flex-col rounded-control px-2 py-1 outline-none data-[highlighted]:bg-card-hover"
                >
                  <span className="flex items-center gap-1.5 text-ui text-fg">
                    <Database size={12} /> {ENGINE_INFO[e].label}
                  </span>
                  <span className="text-small text-fg-muted">{ENGINE_INFO[e].compatible}</span>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <span className="flex-1" />
        {dirty && (
          <Button
            size="sm"
            variant="ghost"
            data-testid="dbservers-revert"
            onClick={() => {
              setDraft(loaded.servers);
              setEdits({});
            }}
          >
            <RotateCcw size={12} /> Revert
          </Button>
        )}
        <Button
          size="sm"
          variant="primary"
          data-testid="dbservers-save"
          disabled={!dirty || saving || problems.length > 0}
          onClick={() => void save()}
        >
          <Save size={12} /> Save
        </Button>
      </div>
      {dirty && problems.length > 0 && (
        <ul data-testid="dbservers-problems" className="text-small text-danger">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="flex min-h-[320px] gap-3">
        <ResourceList
          testId="dbservers-list"
          items={draft}
          selected={current?.id ?? null}
          onSelect={setSelected}
          describe={describeServer}
          empty="No servers yet."
        />
        {current ? (
          <ServerForm
            key={current.id}
            server={current}
            set={(patch) => update(current.id, patch)}
            remove={() => {
              const used = loaded.usage[current.id] ?? [];
              const drop = () => setDraft((list) => list.filter((s) => s.id !== current.id));
              if (!used.length) return drop();
              void confirmDialog({
                title: `Remove ${current.name}?`,
                description: `Its databases are linked in ${used.join(', ')}; agents there lose them until you link another server.`,
                confirmLabel: 'Remove',
                destructive: true,
              }).then((ok) => ok && drop());
            }}
            stored={loaded.stored}
            edits={edits}
            setEdits={setEdits}
            usage={loaded.usage[current.id] ?? []}
          />
        ) : (
          <p className="flex-1 text-small text-fg-muted">
            For example: 10.10.10.15, SQL Server, named FIRMA_1 — discover its databases and keep the ones your projects
            use.
          </p>
        )}
      </div>
    </div>
  );
}
