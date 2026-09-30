import {
  type ApiResource,
  ApiResourceSchema,
  apiSecretKeys,
  type DatabaseEngine,
  type DatabaseResource,
  DatabaseResourceSchema,
  databaseSecretKeys,
  ENGINE_INFO,
  type ImportCandidate,
  newResourceId,
  type ProjectResources,
  type SecretChange,
  secretStatusKey,
  validateResources,
} from '@shared/domain/project-resources';

/** A secret typed in the dialog: a new value, removal, or the secret of an imported connection. */
export type SecretEdit = { value: string } | { remove: true } | { importToken: string };

/** Secret edits by `<resourceId>/<key>`. */
export type SecretEdits = Record<string, SecretEdit>;

const allIds = (r: ProjectResources) => [...r.databases, ...r.apis, ...r.links, ...r.logs].map((x) => x.id);

/** A new database resource with the engine's defaults (read-only, local). */
export function newDatabase(r: ProjectResources, engine: DatabaseEngine): DatabaseResource {
  const info = ENGINE_INFO[engine];
  const taken = new Set(r.databases.map((d) => d.name.toLowerCase()));
  let name = info.label.toLowerCase().replace(/\s+/g, '-');
  for (let i = 2; taken.has(name); i++) name = `${info.label.toLowerCase().replace(/\s+/g, '-')}-${i}`;
  return DatabaseResourceSchema.parse({
    id: newResourceId(allIds(r), 'db'),
    name,
    engine,
    connection: info.file
      ? { kind: 'file', path: 'app.db' }
      : {
          kind: 'fields',
          host: 'localhost',
          ...(info.defaultPort ? { port: info.defaultPort } : {}),
          ...(info.defaultUser ? { user: info.defaultUser } : {}),
          options: {},
        },
    ...(engine === 'sqlserver' ? { tls: { mode: 'require', trustServerCertificate: true } } : {}),
  });
}

export function newApi(r: ProjectResources): ApiResource {
  const taken = new Set(r.apis.map((a) => a.name.toLowerCase()));
  let name = 'api';
  for (let i = 2; taken.has(name); i++) name = `api-${i}`;
  return ApiResourceSchema.parse({ id: newResourceId(allIds(r), 'api'), name, baseUrl: 'http://localhost:3000' });
}

/** A database from an import candidate: `reference` keeps reading the env file, `copy` stores the secret. */
export function databaseFromCandidate(
  r: ProjectResources,
  c: ImportCandidate,
  mode: 'reference' | 'copy',
): { resource: DatabaseResource; secrets: SecretEdits } {
  const base = newDatabase(r, c.engine);
  const name = uniqueName(
    r,
    c.name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || base.name,
  );
  const tls = c.tls ? { ...(base.tls ?? { mode: 'prefer', trustServerCertificate: false }), ...c.tls } : base.tls;
  if (mode === 'reference' && c.reference) {
    return {
      resource: DatabaseResourceSchema.parse({
        ...base,
        name,
        connection: { kind: 'env-ref', file: c.reference.file, variable: c.reference.variable },
        ...(tls ? { tls } : {}),
      }),
      secrets: {},
    };
  }
  if (c.path)
    return {
      resource: DatabaseResourceSchema.parse({ ...base, name, connection: { kind: 'file', path: c.path } }),
      secrets: {},
    };
  const url = c.engine === 'mongodb';
  const resource = DatabaseResourceSchema.parse({
    ...base,
    name,
    connection: url
      ? { kind: 'url' }
      : {
          kind: 'fields',
          host: c.host ?? 'localhost',
          ...(c.port ? { port: c.port } : {}),
          ...(c.database ? { database: c.database } : {}),
          ...(c.user ? { user: c.user } : {}),
          options: c.options ?? {},
        },
    ...(tls ? { tls } : {}),
  });
  const key = url ? 'url' : 'password';
  return { resource, secrets: c.hasSecret ? { [secretStatusKey(resource.id, key)]: { importToken: c.token } } : {} };
}

function uniqueName(r: ProjectResources, wanted: string): string {
  const taken = new Set([...r.databases, ...r.apis, ...r.logs].map((x) => x.name.toLowerCase()));
  let name = wanted;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${wanted}-${i}`;
  return name;
}

/** Whether a secret is set once the edits are saved. */
export function secretState(
  stored: readonly string[],
  edits: SecretEdits,
  resourceId: string,
  key: string,
): 'set' | 'unset' | 'changed' | 'imported' {
  const k = secretStatusKey(resourceId, key);
  const edit = edits[k];
  if (edit && 'remove' in edit) return 'unset';
  if (edit && 'value' in edit) return edit.value ? 'changed' : stored.includes(k) ? 'set' : 'unset';
  if (edit && 'importToken' in edit) return 'imported';
  return stored.includes(k) ? 'set' : 'unset';
}

/** The secret changes to send with a save: only for secrets the resources still use. */
export function secretChanges(r: ProjectResources, edits: SecretEdits): SecretChange[] {
  const used = new Set<string>([
    ...r.databases.flatMap((d) => databaseSecretKeys(d).map((k) => secretStatusKey(d.id, k))),
    ...r.apis.flatMap((a) => apiSecretKeys(a).map((k) => secretStatusKey(a.id, k))),
  ]);
  const out: SecretChange[] = [];
  for (const [k, edit] of Object.entries(edits)) {
    const slash = k.indexOf('/');
    const resourceId = k.slice(0, slash);
    const key = k.slice(slash + 1);
    if ('remove' in edit) out.push({ resourceId, key, value: null });
    else if (!used.has(k)) continue;
    else if ('importToken' in edit) out.push({ resourceId, key, value: null, importToken: edit.importToken });
    else if (edit.value) out.push({ resourceId, key, value: edit.value });
  }
  return out;
}

/** Typed secrets of one resource for "Test connection" (unsaved values and removals). */
export function draftSecretsOf(
  resourceId: string,
  edits: SecretEdits,
): { secrets: Record<string, string | null>; importTokens: Record<string, string> } {
  const secrets: Record<string, string | null> = {};
  const importTokens: Record<string, string> = {};
  const prefix = `${resourceId}/`;
  for (const [k, edit] of Object.entries(edits)) {
    if (!k.startsWith(prefix)) continue;
    const key = k.slice(prefix.length);
    if ('remove' in edit) secrets[key] = null;
    else if ('importToken' in edit) importTokens[key] = edit.importToken;
    else if (edit.value) secrets[key] = edit.value;
  }
  return { secrets, importTokens };
}

/** Problems that block saving the resources (the shared rules plus form-level checks). */
export function resourceProblems(r: ProjectResources): string[] {
  const problems = validateResources(r);
  for (const d of r.databases) {
    if (d.connection.kind === 'env-ref' && (!d.connection.file.trim() || !d.connection.variable.trim()))
      problems.push(`${d.name}: choose the env file and the variable.`);
    if (d.connection.kind === 'file' && !d.connection.path.trim())
      problems.push(`${d.name}: choose the database file.`);
  }
  for (const l of r.logs) if (!l.path.trim()) problems.push(`${l.name}: the log path is missing.`);
  return [...new Set(problems)];
}

/** Splits comma/newline separated globs or paths. */
export const splitList = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** SQL Server LocalDB uses named pipes, which the driver cannot use. */
export const isLocalDb = (host: string): boolean => /^\(localdb\)/i.test(host.trim()) || /^np:/i.test(host.trim());
