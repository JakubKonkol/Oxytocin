import { Database, FileSearch, Plus, Server, Trash2 } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useEffect, useState } from 'react';
import { type DatabaseServer, linkedDatabase } from '@shared/domain/database-servers';
import {
  ACCESS_MODES,
  type AccessMode,
  DATABASE_ENGINES,
  type DatabaseConnection,
  type DatabaseEngine,
  type DatabaseResource,
  DB_LIMITS,
  ENGINE_INFO,
  type ImportCandidate,
  isSqlEngine,
  type ProjectResources,
  RESOURCE_ENVIRONMENTS,
  secretStatusKey,
  type TlsMode,
} from '@shared/domain/project-resources';
import { cn } from '../../../lib/cn';
import { ipc } from '../../../lib/ipc-client';
import { confirmDialog } from '../../../stores/dialog-store';
import { Button } from '../../../ui/Button';
import { notify } from '../../../ui/Toast';
import {
  databaseFromCandidate,
  draftSecretsOf,
  isLocalDb,
  newDatabase,
  type SecretEdits,
  secretState,
  splitList,
} from '../resources-model';
import {
  BridgeNote,
  Check,
  Field,
  input,
  ResourceList,
  SecretInput,
  Section,
  Segmented,
  TestConnection,
} from './controls';

export interface ResourceTabProps {
  projectId: string;
  resources: ProjectResources;
  update: (fn: (r: ProjectResources) => ProjectResources) => void;
  stored: readonly string[];
  edits: SecretEdits;
  setEdits: (fn: (e: SecretEdits) => SecretEdits) => void;
}

const MODE_LABELS: Record<AccessMode, string> = {
  'read-only': 'Read-only',
  'confirm-writes': 'Ask before writes',
  'read-write': 'Read-write',
};

const describe = (d: DatabaseResource) =>
  `${ENGINE_INFO[d.engine].label} · ${d.environment} · ${MODE_LABELS[d.access.mode].toLowerCase()}`;

const num = (value: string, fallback: number, min: number, max: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

function ImportPanel({
  projectId,
  onImport,
  onClose,
}: {
  projectId: string;
  onImport: (c: ImportCandidate, mode: 'reference' | 'copy') => void;
  onClose: () => void;
}) {
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    ipc.invoke('resources:import', { projectId }).then(
      (found) => !cancelled && setCandidates(found),
      (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  return (
    <div data-testid="db-import" className="flex flex-col gap-2 rounded-card border border-line bg-card p-3">
      <div className="flex items-center">
        <h3 className="oxy-label flex-1">Found in the project</h3>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      {error && <div className="text-small text-danger">{error}</div>}
      {!candidates && !error && (
        <div className="text-small text-fg-muted">
          Scanning .env, appsettings, Spring, docker-compose and Prisma files…
        </div>
      )}
      {candidates?.length === 0 && <div className="text-small text-fg-muted">No connection strings found.</div>}
      {candidates?.map((c) => (
        <div
          key={c.token}
          data-testid="db-import-row"
          data-engine={c.engine}
          className="flex items-center gap-2 border-t border-line-subtle pt-2"
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-ui text-fg">
              {ENGINE_INFO[c.engine].label} ·{' '}
              {c.path ?? `${c.host ?? '?'}${c.port ? `:${c.port}` : ''}${c.database ? `/${c.database}` : ''}`}
              {c.user ? <span className="text-fg-muted"> as {c.user}</span> : null}
            </div>
            <div className="truncate text-small text-fg-muted">{c.source}</div>
          </div>
          {c.reference && (
            <Button
              size="sm"
              data-testid="db-import-reference"
              title="Read the value from the file whenever Oxytocin connects (nothing is copied)"
              onClick={() => onImport(c, 'reference')}
            >
              Reference
            </Button>
          )}
          <Button
            size="sm"
            data-testid="db-import-copy"
            title="Copy the connection into Oxytocin (the password goes into the encrypted secret store)"
            onClick={() => onImport(c, 'copy')}
          >
            {c.hasSecret ? 'Copy into Oxytocin' : 'Add'}
          </Button>
        </div>
      ))}
    </div>
  );
}

function ConnectionFields({
  db,
  set,
  props,
}: {
  db: DatabaseResource;
  set: (patch: Partial<DatabaseResource>) => void;
  props: ResourceTabProps;
}) {
  const info = ENGINE_INFO[db.engine];
  const c = db.connection;
  const setConnection = (next: DatabaseConnection) => set({ connection: next });
  const secret = (key: string, label: string, testId: string, hint?: string) => (
    <SecretInput
      label={label}
      testId={testId}
      state={secretState(props.stored, props.edits, db.id, key)}
      onSet={(value) => props.setEdits((e) => ({ ...e, [secretStatusKey(db.id, key)]: { value } }))}
      onRemove={() => props.setEdits((e) => ({ ...e, [secretStatusKey(db.id, key)]: { remove: true } }))}
      onReset={() =>
        props.setEdits((e) => {
          const next = { ...e };
          delete next[secretStatusKey(db.id, key)];
          return next;
        })
      }
      {...(hint ? { hint } : {})}
    />
  );
  const kinds = (info.file ? ['file', 'env-ref'] : ['fields', 'url', 'env-ref']) as DatabaseConnection['kind'][];
  const kindLabel: Record<DatabaseConnection['kind'], string> = {
    fields: 'Host and port',
    url: 'Connection URL',
    'env-ref': 'From an env file',
    file: 'Database file',
    server: 'From a database server',
  };
  const option = (key: string) => (c.kind === 'fields' ? (c.options[key] ?? '') : '');
  const setOption = (key: string, value: string) => {
    if (c.kind !== 'fields') return;
    const options = { ...c.options };
    if (value.trim()) options[key] = value.trim();
    else delete options[key];
    setConnection({ ...c, options });
  };
  const browse = async (purpose: 'sqlite' | 'env' | 'certificate') =>
    ipc.invoke('resources:pickFile', { projectId: props.projectId, purpose });
  return (
    <>
      <Segmented
        label="Connection"
        testId="db-connection-kind"
        value={c.kind}
        options={kinds.map((k) => ({ value: k, label: kindLabel[k] }))}
        onChange={(kind) => {
          if (kind === c.kind) return;
          if (kind === 'fields')
            setConnection({
              kind,
              host: 'localhost',
              ...(info.defaultPort ? { port: info.defaultPort } : {}),
              ...(info.defaultUser ? { user: info.defaultUser } : {}),
              options: {},
            });
          else if (kind === 'url') setConnection({ kind });
          else if (kind === 'file') setConnection({ kind, path: 'app.db' });
          else if (kind === 'env-ref') setConnection({ kind, file: '.env', variable: 'DATABASE_URL' });
        }}
      />
      {c.kind === 'fields' && (
        <>
          <div className="grid grid-cols-[1fr_96px] gap-2">
            <Field
              label="Host"
              hint={
                db.engine === 'sqlserver' && isLocalDb(c.host)
                  ? 'LocalDB uses named pipes, which are not supported: use SQL Server Express/Developer or Docker (TCP).'
                  : undefined
              }
            >
              <input
                data-testid="db-host"
                value={c.host}
                onChange={(e) => setConnection({ ...c, host: e.target.value })}
                className={input}
              />
            </Field>
            <Field label="Port">
              <input
                data-testid="db-port"
                inputMode="numeric"
                value={c.port ?? ''}
                placeholder={String(info.defaultPort ?? '')}
                onChange={(e) => {
                  const port = Number(e.target.value);
                  const { port: _p, ...rest } = c;
                  setConnection(
                    e.target.value && Number.isInteger(port) && port > 0 && port < 65536 ? { ...rest, port } : rest,
                  );
                }}
                className={input}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field
              label={db.engine === 'oracle' ? 'Service name' : db.engine === 'redis' ? 'Database number' : 'Database'}
            >
              <input
                data-testid="db-database"
                value={db.engine === 'redis' ? option('db') : (c.database ?? '')}
                placeholder={info.databaseHint ?? (db.engine === 'redis' ? '0' : '')}
                onChange={(e) => {
                  if (db.engine === 'redis') return setOption('db', e.target.value);
                  const { database: _d, ...rest } = c;
                  setConnection(e.target.value ? { ...rest, database: e.target.value } : rest);
                }}
                className={input}
              />
            </Field>
            {info.user && (
              <Field label="User">
                <input
                  data-testid="db-user"
                  value={c.user ?? ''}
                  placeholder={info.defaultUser ?? ''}
                  onChange={(e) => {
                    const { user: _u, ...rest } = c;
                    setConnection(e.target.value ? { ...rest, user: e.target.value } : rest);
                  }}
                  className={input}
                />
              </Field>
            )}
          </div>
          {secret('password', 'Password', 'db-password', 'A read-only database account is recommended.')}
          {db.engine === 'sqlserver' && (
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
          )}
          {db.engine === 'mongodb' && (
            <Field label="Authentication database" hint="authSource, e.g. admin">
              <input
                value={option('authSource')}
                onChange={(e) => setOption('authSource', e.target.value)}
                className={input}
              />
            </Field>
          )}
          {db.engine === 'oracle' && (
            <Check checked={option('sid') === 'true'} onChange={(v) => setOption('sid', v ? 'true' : '')}>
              The name is a SID, not a service name
            </Check>
          )}
        </>
      )}
      {c.kind === 'url' &&
        secret(
          'url',
          'Connection URL',
          'db-url',
          `e.g. ${info.urlSchemes[0]}://user:password@host${info.defaultPort ? `:${info.defaultPort}` : ''}/database — stored encrypted, as a whole.`,
        )}
      {c.kind === 'env-ref' && (
        <div className="grid grid-cols-[1fr_1fr] gap-2">
          <Field label="Env file" hint="Read when Oxytocin connects; nothing is copied.">
            <div className="flex gap-1">
              <input
                data-testid="db-env-file"
                value={c.file}
                onChange={(e) => setConnection({ ...c, file: e.target.value })}
                className={cn(input, 'font-mono')}
              />
              <Button size="sm" onClick={() => void browse('env').then((p) => p && setConnection({ ...c, file: p }))}>
                …
              </Button>
            </div>
          </Field>
          <Field label="Variable">
            <input
              data-testid="db-env-variable"
              value={c.variable}
              onChange={(e) => setConnection({ ...c, variable: e.target.value })}
              className={cn(input, 'font-mono')}
            />
          </Field>
        </div>
      )}
      {c.kind === 'file' && (
        <Field
          label="Database file"
          hint="Relative to the project root or absolute. Read-only access opens the file read-only."
        >
          <div className="flex gap-1">
            <input
              data-testid="db-file"
              value={c.path}
              onChange={(e) => setConnection({ ...c, path: e.target.value })}
              className={cn(input, 'font-mono')}
            />
            <Button size="sm" onClick={() => void browse('sqlite').then((p) => p && setConnection({ ...c, path: p }))}>
              Browse…
            </Button>
          </div>
        </Field>
      )}
      {!info.file && (
        <div className="grid grid-cols-2 items-end gap-2">
          <Field label="TLS">
            <select
              data-testid="db-tls"
              value={db.tls?.mode ?? 'prefer'}
              onChange={(e) =>
                set({
                  tls: {
                    mode: e.target.value as TlsMode,
                    trustServerCertificate: db.tls?.trustServerCertificate ?? false,
                    ...(db.tls?.caPath ? { caPath: db.tls.caPath } : {}),
                  },
                })
              }
              className={input}
            >
              <option value="disable">Disable</option>
              <option value="prefer">
                {db.engine === 'sqlserver' ? 'Encrypt' : 'Prefer (when the server offers it)'}
              </option>
              <option value="require">Require (not verified)</option>
              <option value="verify">Require and verify the certificate</option>
            </select>
          </Field>
          {db.engine === 'sqlserver' && (
            <Check
              testId="db-trust-certificate"
              checked={db.tls?.trustServerCertificate ?? false}
              onChange={(v) =>
                set({
                  tls: {
                    mode: db.tls?.mode ?? 'prefer',
                    ...(db.tls?.caPath ? { caPath: db.tls.caPath } : {}),
                    trustServerCertificate: v,
                  },
                })
              }
            >
              Trust server certificate (local development)
            </Check>
          )}
          {db.tls?.mode === 'verify' && (
            <Field label="CA certificate (PEM)" hint="Optional; the system's CAs otherwise.">
              <div className="flex gap-1">
                <input
                  value={db.tls.caPath ?? ''}
                  onChange={(e) => set({ tls: { ...db.tls!, ...(e.target.value ? { caPath: e.target.value } : {}) } })}
                  className={cn(input, 'font-mono')}
                />
                <Button
                  size="sm"
                  onClick={() => void browse('certificate').then((p) => p && set({ tls: { ...db.tls!, caPath: p } }))}
                >
                  …
                </Button>
              </div>
            </Field>
          )}
        </div>
      )}
    </>
  );
}

/** The connection of a database linked from Settings → Database Servers. */
function LinkedConnection({
  db,
  set,
  servers,
}: {
  db: DatabaseResource;
  set: (patch: Partial<DatabaseResource>) => void;
  servers: DatabaseServer[] | null;
}) {
  if (db.connection.kind !== 'server') return null;
  const c = db.connection;
  const server = servers?.find((s) => s.id === c.serverId);
  const listId = `server-dbs-${db.id}`;
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Server">
          <select
            data-testid="db-server"
            value={c.serverId}
            onChange={(e) => {
              const next = servers?.find((s) => s.id === e.target.value);
              if (next) set({ connection: { ...c, serverId: next.id }, engine: next.engine });
            }}
            className={input}
          >
            {!server && <option value={c.serverId}>(removed server)</option>}
            {(servers ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({ENGINE_INFO[s.engine].label})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Database on the server">
          <input
            data-testid="db-server-database"
            list={listId}
            value={c.database}
            onChange={(e) => set({ connection: { ...c, database: e.target.value } })}
            className={cn(input, 'font-mono')}
          />
          <datalist id={listId}>
            {server?.databases.map((d) => (
              <option key={d.name} value={d.name} />
            ))}
          </datalist>
        </Field>
      </div>
      {servers && !server ? (
        <p
          className="rounded-control border border-danger px-2 py-1 text-small text-fg"
          data-testid="db-server-missing"
        >
          This server was removed from Settings → Database Servers: choose another one, or remove the database.
        </p>
      ) : (
        <p className="text-small text-fg-muted" data-testid="db-server-note">
          {server
            ? `${server.host}${server.port ? `:${server.port}` : ''}${server.user ? ` as ${server.user}` : ''} — `
            : ''}
          the host, login, password and TLS come from Settings → Database Servers; what agents may do is set here, per
          project.
        </p>
      )}
    </>
  );
}

/** Picks databases of Settings → Database Servers to link into this project. */
function LinkFromServers({
  resources,
  servers,
  onAdd,
  onClose,
}: {
  resources: ProjectResources;
  servers: DatabaseServer[] | null;
  onAdd: (picked: { server: DatabaseServer; database: string }[]) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const key = (serverId: string, name: string) => `${serverId}/${name.toLowerCase()}`;
  const linked = new Set(
    resources.databases.flatMap((d) =>
      d.connection.kind === 'server' ? [key(d.connection.serverId, d.connection.database)] : [],
    ),
  );
  const choices = (servers ?? []).flatMap((s) => s.databases.map((d) => ({ server: s, database: d.name })));
  return (
    <div
      data-testid="db-link"
      className="flex max-h-72 flex-col gap-2 overflow-auto rounded-card border border-line bg-card p-3"
    >
      <div className="flex items-center gap-2">
        <h3 className="oxy-label flex-1">Databases of your servers</h3>
        <Button
          size="sm"
          variant="primary"
          data-testid="db-link-add"
          disabled={picked.size === 0}
          onClick={() => onAdd(choices.filter((c) => picked.has(key(c.server.id, c.database))))}
        >
          Add {picked.size || ''} selected
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      {servers === null && <div className="text-small text-fg-muted">Loading…</div>}
      {servers?.length === 0 && (
        <div className="text-small text-fg-muted" data-testid="db-link-empty">
          No database servers yet. Add them once in Settings → Database Servers (for example 10.10.10.15, SQL Server,
          named FIRMA_1), then link their databases here.
        </div>
      )}
      {servers?.map((s) => (
        <div key={s.id} data-testid="db-link-server" data-name={s.name} className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1.5 text-ui font-medium text-fg">
            <Server size={12} className="text-fg-muted" /> {s.name}
            <span className="text-small font-normal text-fg-muted">
              {ENGINE_INFO[s.engine].label} · {s.host} · {s.environment}
            </span>
          </div>
          {s.databases.length === 0 && (
            <div className="pl-5 text-small text-fg-muted">No databases on its list: discover them in Settings.</div>
          )}
          {s.databases.map((d) => {
            const k = key(s.id, d.name);
            const already = linked.has(k);
            return (
              <label
                key={d.name}
                data-testid="db-link-item"
                data-name={`${s.name}/${d.name}`}
                className={cn('flex items-center gap-2 pl-5 text-fg-secondary', already && 'opacity-60')}
              >
                <input
                  type="checkbox"
                  disabled={already}
                  checked={already || picked.has(k)}
                  onChange={(e) =>
                    setPicked((p) => {
                      const next = new Set(p);
                      if (e.target.checked) next.add(k);
                      else next.delete(k);
                      return next;
                    })
                  }
                />
                <span className="font-mono">{d.name}</span>
                {already && <span className="text-small text-fg-muted">linked</span>}
              </label>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function DatabaseForm({
  db,
  props,
  servers,
}: {
  db: DatabaseResource;
  props: ResourceTabProps;
  servers: DatabaseServer[] | null;
}) {
  const linked = db.connection.kind === 'server';
  const set = (patch: Partial<DatabaseResource>) =>
    props.update((r) => ({ ...r, databases: r.databases.map((d) => (d.id === db.id ? { ...d, ...patch } : d)) }));
  const setAccess = (patch: Partial<DatabaseResource['access']>) => set({ access: { ...db.access, ...patch } });
  const setAgents = (patch: Partial<DatabaseResource['agents']>) => set({ agents: { ...db.agents, ...patch } });
  const production = db.environment === 'production';
  const sql = isSqlEngine(db.engine);
  return (
    <div data-testid="db-form" className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto pr-1">
      <Section
        title="Connection"
        action={
          <Button
            size="sm"
            variant="ghost"
            data-testid="db-remove"
            onClick={() => props.update((r) => ({ ...r, databases: r.databases.filter((d) => d.id !== db.id) }))}
          >
            <Trash2 size={12} /> Remove
          </Button>
        }
      >
        <div className="grid grid-cols-[1fr_140px_140px] gap-2">
          <Field label="Name" hint="Agents choose the database by this name.">
            <input
              data-testid="db-name"
              value={db.name}
              onChange={(e) => set({ name: e.target.value })}
              className={input}
            />
          </Field>
          <Field label="Engine">
            <select
              data-testid="db-engine"
              value={db.engine}
              disabled={linked}
              title={linked ? 'The engine of the database server' : undefined}
              onChange={(e) => {
                const engine = e.target.value as DatabaseEngine;
                const fresh = newDatabase({ ...props.resources, databases: [] }, engine);
                set({ engine, connection: fresh.connection, ...(fresh.tls ? { tls: fresh.tls } : {}) });
              }}
              className={input}
            >
              {DATABASE_ENGINES.map((e) => (
                <option key={e} value={e}>
                  {ENGINE_INFO[e].label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Environment">
            <select
              data-testid="db-environment"
              value={db.environment}
              onChange={(e) => {
                const environment = e.target.value as DatabaseResource['environment'];
                set({
                  environment,
                  ...(environment === 'production' && db.access.mode === 'read-write'
                    ? { access: { ...db.access, mode: 'confirm-writes' } }
                    : {}),
                });
              }}
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
        {linked ? (
          <LinkedConnection db={db} set={set} servers={servers} />
        ) : (
          <>
            <div className="text-small text-fg-muted">Works with {ENGINE_INFO[db.engine].compatible}.</div>
            <ConnectionFields db={db} set={set} props={props} />
          </>
        )}
        <TestConnection
          testId="db-test"
          run={() =>
            ipc.invoke('resources:test', {
              projectId: props.projectId,
              kind: 'database',
              resource: db,
              ...draftSecretsOf(db.id, props.edits),
            })
          }
        />
      </Section>

      <Section title="What agents may do">
        <Segmented<AccessMode>
          label="Access"
          testId="db-access-mode"
          value={db.access.mode}
          options={ACCESS_MODES.filter((m) => !(production && m === 'read-write')).map((m) => ({
            value: m,
            label: MODE_LABELS[m],
            ...(m === 'confirm-writes'
              ? { tone: 'warning' as const }
              : m === 'read-write'
                ? { tone: 'danger' as const }
                : {}),
          }))}
          onChange={(mode) => {
            if (mode !== 'read-write') return setAccess({ mode });
            void confirmDialog({
              title: `Let agents write to ${db.name} without asking?`,
              description:
                'Agents could insert, update and delete data freely. DROP, TRUNCATE and UPDATE/DELETE without WHERE still ask. Use a development database.',
              confirmLabel: 'Allow writes',
              destructive: true,
            }).then((ok) => ok && setAccess({ mode }));
          }}
        />
        {db.access.mode === 'read-only' && (
          <p className="text-small text-fg-muted">
            Only plain reads pass (one statement, built-in functions); reads also run in read-only transactions where
            the engine has them.
          </p>
        )}
        {db.access.mode === 'confirm-writes' && (
          <p className="rounded-control border border-warning px-2 py-1 text-small text-fg" data-testid="db-mode-note">
            Every statement that is not a plain read asks you first, with the full statement.
          </p>
        )}
        {db.access.mode === 'read-write' && (
          <p className="rounded-control border border-danger px-2 py-1 text-small text-fg" data-testid="db-mode-note">
            Agents write without asking, except DROP, TRUNCATE, ALTER … DROP and UPDATE/DELETE without WHERE.
          </p>
        )}
        {production && <p className="text-small text-fg-muted">Production databases cannot be read-write.</p>}
        <div className="grid grid-cols-3 gap-2">
          <Field label="Rows per result">
            <input
              data-testid="db-max-rows"
              type="number"
              min={DB_LIMITS.maxRows.min}
              max={DB_LIMITS.maxRows.max}
              value={db.access.maxRows}
              onChange={(e) =>
                setAccess({
                  maxRows: num(e.target.value, db.access.maxRows, DB_LIMITS.maxRows.min, DB_LIMITS.maxRows.max),
                })
              }
              className={input}
            />
          </Field>
          <Field label="Time limit (s)">
            <input
              type="number"
              min={1}
              max={300}
              value={Math.round(db.access.timeoutMs / 1000)}
              onChange={(e) => setAccess({ timeoutMs: num(e.target.value, db.access.timeoutMs / 1000, 1, 300) * 1000 })}
              className={input}
            />
          </Field>
          <Field label="Result size (KB)">
            <input
              type="number"
              min={4}
              max={4096}
              value={Math.round(db.access.maxResultBytes / 1024)}
              onChange={(e) =>
                setAccess({ maxResultBytes: num(e.target.value, db.access.maxResultBytes / 1024, 4, 4096) * 1024 })
              }
              className={input}
            />
          </Field>
        </div>
        {sql && db.engine !== 'clickhouse' && (
          <Check
            testId="db-user-functions"
            checked={db.access.allowUserFunctions}
            onChange={(v) => setAccess({ allowUserFunctions: v })}
          >
            Allow user-defined functions in reads (the bridge cannot tell whether they write)
          </Check>
        )}
        <Field
          label="Masked columns and fields"
          hint="Values of matching names are shown to agents as ***. Globs, comma or line separated."
        >
          <textarea
            data-testid="db-masking"
            rows={2}
            value={db.masking.join(', ')}
            onChange={(e) => set({ masking: splitList(e.target.value) })}
            className={cn(input, 'h-auto py-1 font-mono text-small')}
          />
        </Field>
      </Section>

      <Section title="Agents">
        <Check testId="db-exposed" checked={db.agents.exposed} onChange={(v) => setAgents({ exposed: v })}>
          Available to agents
        </Check>
        <Check
          checked={db.agents.shareWithRelated}
          onChange={(v) => setAgents({ shareWithRelated: v })}
          disabled={!db.agents.exposed}
        >
          Share with related projects
        </Check>
        <Field label="Notes for agents" hint='Told to agents with the database, e.g. "balances are in cents".'>
          <textarea
            data-testid="db-description"
            rows={2}
            maxLength={2000}
            value={db.agents.description ?? ''}
            onChange={(e) => setAgents({ description: e.target.value || undefined })}
            className={cn(input, 'h-auto py-1')}
          />
        </Field>
        <BridgeNote />
      </Section>
    </div>
  );
}

/** Project settings → Databases. */
export function DatabasesTab(props: ResourceTabProps) {
  const { resources, update } = props;
  const [selected, setSelected] = useState<string | null>(resources.databases[0]?.id ?? null);
  const [importing, setImporting] = useState(false);
  const [linking, setLinking] = useState(false);
  const [servers, setServers] = useState<DatabaseServer[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      ipc.invoke('dbServers:get').then(
        (r) => !cancelled && setServers(r.servers),
        () => !cancelled && setServers([]),
      );
    void load();
    const off = ipc.on('dbServers:changed', () => void load());
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  const current = resources.databases.find((d) => d.id === selected) ?? resources.databases[0];
  const add = (engine: DatabaseEngine) => {
    const db = newDatabase(resources, engine);
    update((r) => ({ ...r, databases: [...r.databases, db] }));
    setSelected(db.id);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="tab-databases">
      <div className="flex items-center gap-2">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Button size="sm" data-testid="db-add">
              <Plus size={12} /> Add database
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              sideOffset={4}
              className="z-[60] w-72 rounded-card border border-line bg-elevated p-1 shadow-elevated"
            >
              {DATABASE_ENGINES.map((e) => (
                <DropdownMenu.Item
                  key={e}
                  data-testid={`db-add-${e}`}
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
        <Button size="sm" variant="ghost" data-testid="db-link-open" onClick={() => setLinking(true)}>
          <Server size={12} /> Add from servers…
        </Button>
        <Button size="sm" variant="ghost" data-testid="db-import-open" onClick={() => setImporting(true)}>
          <FileSearch size={12} /> Import from project…
        </Button>
      </div>
      {linking && (
        <LinkFromServers
          resources={resources}
          servers={servers}
          onClose={() => setLinking(false)}
          onAdd={(picked) => {
            let next = resources;
            const added: DatabaseResource[] = [];
            for (const { server, database } of picked) {
              const db = linkedDatabase(next, server, database);
              added.push(db);
              next = { ...next, databases: [...next.databases, db] };
            }
            update((r) => ({ ...r, databases: [...r.databases, ...added] }));
            if (added[0]) setSelected(added[0].id);
            setLinking(false);
            notify('success', `Linked ${added.length} database${added.length === 1 ? '' : 's'}`, {
              description: 'Read-only by default: choose what agents may do, then save.',
            });
          }}
        />
      )}
      {importing && (
        <ImportPanel
          projectId={props.projectId}
          onClose={() => setImporting(false)}
          onImport={(c, mode) => {
            const { resource, secrets } = databaseFromCandidate(resources, c, mode);
            update((r) => ({ ...r, databases: [...r.databases, resource] }));
            props.setEdits((e) => ({ ...e, ...secrets }));
            setSelected(resource.id);
            notify('success', `Added ${resource.name}`, {
              description: 'Test the connection and choose what agents may do, then save.',
            });
          }}
        />
      )}
      <div className="flex min-h-0 flex-1 gap-3">
        <ResourceList
          testId="db-list"
          items={resources.databases}
          selected={current?.id ?? null}
          onSelect={setSelected}
          describe={describe}
          empty="No databases yet."
        />
        {current ? (
          <DatabaseForm key={current.id} db={current} props={props} servers={servers} />
        ) : (
          <div className="flex flex-1 flex-col gap-2 text-small text-fg-muted">
            <p>
              Describe the project's databases and agents can read the schema and query them through Oxytocin's tools —
              with the credentials added by Oxytocin and only what you allow (read-only by default).
            </p>
            <BridgeNote />
          </div>
        )}
      </div>
    </div>
  );
}
