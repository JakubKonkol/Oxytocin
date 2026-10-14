import { z } from 'zod';
import {
  type DatabaseServer,
  DatabaseServersSchema,
  SERVER_SECRET_SCOPE,
  validateServers,
} from '@shared/domain/database-servers';
import type { SecretChange, SecretsStatus } from '@shared/domain/project-resources';
import { OxyError } from '@shared/errors';
import type { Logger } from '@shared/logging/logger';
import { type Disposable } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';
import { JsonFileStore } from '../storage/json-file-store';
import type { SecretStore } from '../secrets/secret-store';

const ServersFileSchema = z.object({
  version: z.literal(1),
  /** Raw: a server this version cannot read is kept as it is (a newer Oxytocin wrote it). */
  servers: z.array(z.unknown()),
});
type ServersFile = z.infer<typeof ServersFileSchema>;

export interface DatabaseServerServiceDeps {
  file: string;
  secrets: SecretStore;
  logger: Logger;
}

/**
 * Settings → Database Servers: servers configured once (`database-servers.json`) whose databases projects link.
 * Passwords live in the SecretStore under {@link SERVER_SECRET_SCOPE}.
 */
export class DatabaseServerService implements Disposable {
  private readonly store: JsonFileStore<ServersFile>;
  private readonly changeEmitter = new Emitter<{ changedIds: string[] }>();
  /** Servers were saved; `changedIds` lists the servers whose connection changed or that were removed. */
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly deps: DatabaseServerServiceDeps) {
    this.store = new JsonFileStore({
      path: deps.file,
      schema: ServersFileSchema,
      defaults: () => ({ version: 1, servers: [] }),
      debounceMs: 0,
      backup: true,
      logger: deps.logger,
    });
  }

  async load(): Promise<void> {
    await this.store.load();
  }

  /** The servers this version can read. */
  list(): DatabaseServer[] {
    const out: DatabaseServer[] = [];
    for (const raw of this.store.get().servers) {
      const parsed = DatabaseServersSchema.element.safeParse(raw);
      if (parsed.success) out.push(parsed.data);
      else this.deps.logger.warn(`A database server could not be read: ${parsed.error.issues[0]?.message ?? ''}`);
    }
    return out;
  }

  get(id: string): DatabaseServer | undefined {
    return this.list().find((s) => s.id === id);
  }

  secretsStatus(): SecretsStatus {
    return this.deps.secrets.status(SERVER_SECRET_SCOPE);
  }

  /** The decrypted password of a server (main only). */
  secrets(serverId: string): Record<string, string> {
    return this.deps.secrets.getAll(SERVER_SECRET_SCOPE, serverId);
  }

  /** Saved secrets merged with values typed but not saved yet (for discovery). */
  draftSecrets(serverId: string, typed: Record<string, string | null>): Record<string, string> {
    const stored = this.secrets(serverId);
    for (const [k, v] of Object.entries(typed)) {
      if (v === null) delete stored[k];
      else stored[k] = v;
    }
    return stored;
  }

  async save(input: unknown, secretChanges: SecretChange[] = []): Promise<DatabaseServer[]> {
    const parsed = DatabaseServersSchema.safeParse(input);
    if (!parsed.success) throw new OxyError('INVALID', `Invalid servers: ${parsed.error.issues[0]?.message ?? ''}`);
    const next = parsed.data.map((s) => ({ ...s, name: s.name.trim() }));
    const problems = validateServers(next);
    if (problems.length) throw new OxyError('INVALID', problems.join(' '));
    const ids = new Set(next.map((s) => s.id));
    for (const change of secretChanges) {
      if (!ids.has(change.resourceId)) throw new OxyError('INVALID', `No server ${change.resourceId}.`);
      if (change.key !== 'password') throw new OxyError('INVALID', 'A server only has a password.');
      if (change.value === null) await this.deps.secrets.delete(SERVER_SECRET_SCOPE, change.resourceId, change.key);
      else await this.deps.secrets.set(SERVER_SECRET_SCOPE, change.resourceId, change.key, change.value);
    }
    await this.deps.secrets.retain(SERVER_SECRET_SCOPE, ids);
    const connection = (s: DatabaseServer) =>
      JSON.stringify([s.engine, s.host, s.port, s.user, s.options, s.tls, s.name, s.environment]);
    const before = new Map(this.list().map((s) => [s.id, connection(s)]));
    const after = new Map(next.map((s) => [s.id, connection(s)]));
    const changedIds = [
      ...[...before.keys()].filter((id) => before.get(id) !== after.get(id)),
      ...secretChanges.map((c) => c.resourceId),
    ];
    // Servers this version could not read are kept.
    const unreadable = this.store.get().servers.filter((raw) => !DatabaseServersSchema.element.safeParse(raw).success);
    this.store.set({ version: 1, servers: [...next, ...unreadable] });
    await this.store.flush();
    this.changeEmitter.fire({ changedIds: [...new Set(changedIds)] });
    return next;
  }

  flush(): Promise<void> {
    return this.store.flush();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
