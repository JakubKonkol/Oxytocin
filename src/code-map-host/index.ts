import { CodeMapStatusSchema, type CodeMapStatus } from '@shared/domain/code-map';
import { startHostRuntime } from '@shared/rpc/host-runtime';
import {
  CodeMapHostContracts,
  type CodeMapHostEvents,
  type CodeMapHostMethods,
} from '@shared/rpc/contracts/code-map-host';
import { CodeMapCheckouts } from './checkouts';

declare const __OXYTOCIN_VERSION__: string;
const pending = new Map<string, CodeMapStatus>();
let timer: ReturnType<typeof setTimeout> | undefined;
const checkouts = new CodeMapCheckouts(`Oxytocin ${__OXYTOCIN_VERSION__}`, (status) => {
  pending.set(status.checkoutId, status);
  if (timer) return;
  // Bound status traffic to four events per second, including many simultaneous checkouts.
  const emitNext = () => {
    timer = undefined;
    const first = pending.entries().next();
    if (first.done) return;
    pending.delete(first.value[0]);
    runtime.rpc.emit('checkout:status', CodeMapStatusSchema.parse(first.value[1]));
    if (pending.size) timer = setTimeout(emitNext, 250);
  };
  timer = setTimeout(emitNext, 250);
});

type Impl = { [K in keyof Omit<CodeMapHostMethods, 'ping' | 'shutdown'>]: (params: unknown) => unknown };
const impl: Impl = {
  'hints:update': (input) => {
    checkouts.hints(CodeMapHostContracts['hints:update'].params.parse(input));
    return null;
  },
  'checkout:configure': (input) => checkouts.configure(CodeMapHostContracts['checkout:configure'].params.parse(input)),
  'checkout:remove': async (input) => {
    await checkouts.remove(CodeMapHostContracts['checkout:remove'].params.parse(input).checkoutId);
    return null;
  },
  'checkout:rebuild': (input) =>
    checkouts.rebuild(CodeMapHostContracts['checkout:rebuild'].params.parse(input).checkoutId),
  'checkout:pause': (input) => checkouts.pause(CodeMapHostContracts['checkout:pause'].params.parse(input).checkoutId),
  'checkout:resume': (input) =>
    checkouts.resume(CodeMapHostContracts['checkout:resume'].params.parse(input).checkoutId),
  'checkout:deleteData': (input) =>
    checkouts.deleteData(CodeMapHostContracts['checkout:deleteData'].params.parse(input).checkoutId),
  'checkout:status': (input) =>
    checkouts.status(CodeMapHostContracts['checkout:status'].params.parse(input).checkoutId),
  'checkout:diagnostics': (input) =>
    checkouts.diagnostics(CodeMapHostContracts['checkout:diagnostics'].params.parse(input).checkoutId),
};
const runtime = startHostRuntime<CodeMapHostEvents>({
  parentPort: process.parentPort,
  scope: 'map',
  pid: process.pid,
  impl,
  onShutdown: async () => {
    if (timer) clearTimeout(timer);
    pending.clear();
    await checkouts.dispose();
  },
  exit: (code) => process.exit(code),
});
runtime.log.info('Code Map Host started');
