import { startHostRuntime } from '@shared/rpc/host-runtime';

// Utility process entry: the Plugin Host. Domain logic is added in later milestones.
const parentPort = process.parentPort;

const { log } = startHostRuntime({
  parentPort,
  scope: 'plugin',
  pid: process.pid,
  impl: {},
  exit: (code) => process.exit(code),
});

log.info('Plugin Host started');
