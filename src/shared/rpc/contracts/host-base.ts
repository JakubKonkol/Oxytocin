import type { LogRecord } from '../../logging/logger';

/** Methods every utility host serves. */
export type HostBaseMethods = {
  ping: (p: null) => 'pong';
  /** Graceful shutdown: the host cleans up and exits on its own. */
  shutdown: (p: null) => void;
};

/** Events every utility host emits to main. */
export type HostBaseEvents = {
  ready: { pid: number };
  log: LogRecord;
};
