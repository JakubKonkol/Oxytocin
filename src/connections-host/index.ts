import { startHostRuntime } from '@shared/rpc/host-runtime';
import type { ConnectionsHostEvents, ConnectionsHostMethods } from '@shared/rpc/contracts/connections-host';
import { DbService } from './db/db-service';
import { ApiService } from './http/api-service';
import { ImportScanner } from './import/scan';
import { tailLog } from './logs/tail';

// Utility process entry: the Connections Host. Database drivers, HTTP requests to project APIs, log files
// and project scans run here so a slow or crashing driver never blocks the main process.
const parentPort = process.parentPort;

const db = new DbService();
const api = new ApiService();
const scanner = new ImportScanner();

type Impl<M> = {
  [K in keyof M]: M[K] extends (params: infer P) => infer R ? (params: P) => R | Promise<R> : never;
};

const impl: Impl<Omit<ConnectionsHostMethods, 'ping' | 'shutdown'>> = {
  'db:test': (o) => db.test(o),
  'db:schema': async (o) => ({ text: await db.schema(o) }),
  'db:query': (o) => db.query(o),
  'db:mongo': (o) => db.mongo(o),
  'db:redis': (o) => db.redis(o),
  'db:close': ({ keys }) => {
    db.close(keys);
    api.forget(keys);
  },
  'api:test': (o) => api.test(o),
  'api:describe': async (o) => ({ text: await api.describe(o) }),
  'api:request': (o) => api.request(o),
  'logs:tail': async ({ resource, projectRoot, lines, grep }) => ({
    text: await tailLog({ root: projectRoot, path: resource.path, lines, ...(grep ? { grep } : {}) }),
  }),
  'import:scan': ({ root }) => scanner.scan(root),
  'import:secret': ({ root, token }) => ({ value: scanner.secretFor(root, token) }),
};

const { log } = startHostRuntime<ConnectionsHostEvents>({
  parentPort,
  scope: 'conn',
  pid: process.pid,
  impl,
  onShutdown: () => db.dispose(),
  exit: (code) => process.exit(code),
});

// Drivers sometimes reject promises nobody awaits (a pool losing its connection): log instead of crashing.
process.on('unhandledRejection', (reason) => log.warn('Unhandled promise rejection in the Connections Host', reason));

log.info('Connections Host started');
