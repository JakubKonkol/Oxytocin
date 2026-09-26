import { startHostRuntime } from '@shared/rpc/host-runtime';

// Utility process entry: the PTY Host. Domain logic is added in later milestones.
const parentPort = process.parentPort;

const { log } = startHostRuntime({
  parentPort,
  scope: 'pty',
  pid: process.pid,
  impl: {},
  exit: (code) => process.exit(code),
});

log.info('PTY Host started');
