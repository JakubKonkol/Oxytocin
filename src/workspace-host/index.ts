import { startHostRuntime } from '@shared/rpc/host-runtime';

// Utility process entry: the Workspace Host. Domain logic is added in later milestones.
const parentPort = process.parentPort;

const { log } = startHostRuntime({
  parentPort,
  scope: 'ws',
  pid: process.pid,
  impl: {},
  exit: (code) => process.exit(code),
});

log.info('Workspace Host started');
