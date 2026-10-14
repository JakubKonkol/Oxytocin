import { type DatabaseServer, type DiscoveredDatabase, type DiscoveryResult } from '@shared/domain/database-servers';
import { ENGINE_INFO, type SecretChange, secretStatusKey } from '@shared/domain/project-resources';
import type { SecretEdits } from '../projects/resources-model';

/** "SQL Server · 10.10.10.15 · 3 databases". */
export function describeServer(s: DatabaseServer): string {
  const where = s.host ? `${s.host}${s.port ? `:${s.port}` : ''}` : 'no host';
  return `${ENGINE_INFO[s.engine].label} · ${where} · ${s.databases.length} database${s.databases.length === 1 ? '' : 's'}`;
}

/** Password changes to save: only for servers that still exist. */
export function serverSecretChanges(servers: readonly DatabaseServer[], edits: SecretEdits): SecretChange[] {
  const ids = new Set(servers.map((s) => s.id));
  const out: SecretChange[] = [];
  for (const [k, edit] of Object.entries(edits)) {
    const [id, key] = k.split('/');
    if (!id || key !== 'password' || !ids.has(id)) continue;
    if ('remove' in edit) out.push({ resourceId: id, key, value: null });
    else if ('value' in edit && edit.value) out.push({ resourceId: id, key, value: edit.value });
  }
  return out;
}

/** The password typed for discovery: a value, null when removed in the form, undefined: the saved one. */
export function typedPassword(edits: SecretEdits, serverId: string): string | null | undefined {
  const edit = edits[secretStatusKey(serverId, 'password')];
  if (!edit) return undefined;
  if ('remove' in edit) return null;
  return 'value' in edit && edit.value ? edit.value : undefined;
}

/** Discovered databases not on the server's list yet (system databases only when asked for). */
export function newlyFound(
  result: DiscoveryResult | undefined,
  server: DatabaseServer,
  showSystem: boolean,
): DiscoveredDatabase[] {
  if (!result?.ok) return [];
  const have = new Set(server.databases.map((d) => d.name.toLowerCase()));
  return result.databases.filter((d) => !have.has(d.name.toLowerCase()) && (showSystem || !d.system));
}

export const sameServers = (a: readonly DatabaseServer[], b: readonly DatabaseServer[]): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
