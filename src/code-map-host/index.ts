import { CodeMapStatusSchema, type CodeMapStatus } from '@shared/domain/code-map';
import { startHostRuntime } from '@shared/rpc/host-runtime';
import {
  CodeMapHostContracts,
  type CodeMapHostEvents,
  type CodeMapHostMethods,
} from '@shared/rpc/contracts/code-map-host';
import { CodeMapCheckouts } from './checkouts';
import { LearningMemory } from './memory/admission';
import { listArchives } from './memory/store';
import { LearningTools } from './memory/agent-tools';

declare const __OXYTOCIN_VERSION__: string;
const pending = new Map<string, CodeMapStatus>();
let timer: ReturnType<typeof setTimeout> | undefined;
const checkouts = new CodeMapCheckouts(
  `Oxytocin ${__OXYTOCIN_VERSION__}`,
  (status) => {
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
  },
  {
    assets: process.env['OXYTOCIN_CODE_MAP_ASSETS'] ?? resolve(__dirname, '../code-map'),
    parserEntry: join(__dirname, 'codeMapParserWorker.js'),
  },
);

type Impl = { [K in keyof Omit<CodeMapHostMethods, 'ping' | 'shutdown'>]: (params: unknown) => unknown };
const memory = new LearningMemory(
  (checkoutId) => checkouts.memorySnapshot(checkoutId),
  undefined,
  (projectId, checkoutId, memoryRevision) => {
    runtime.rpc.emit('memory:changed', { projectId, checkoutId, memoryRevision });
  },
);
const learningTools = new LearningTools(checkouts, memory);
const impl: Impl = {
  'memory:view': (input) => {
    const p = CodeMapHostContracts['memory:view'].params.parse(input);
    return learningTools.view(p.requestId, p.authority, p.query, p.mode);
  },
  'memory:agent': (input) => {
    const p = CodeMapHostContracts['memory:agent'].params.parse(input);
    return learningTools.run(p.requestId, p.authority, p.actor, p.request, p.mode);
  },
  'memory:cancel': (input) => {
    learningTools.cancel(CodeMapHostContracts['memory:cancel'].params.parse(input).requestId);
    return null;
  },
  'memory:revoke': (input) => {
    const p = CodeMapHostContracts['memory:revoke'].params.parse(input);
    learningTools.revoke(p.projectId, p.checkoutId);
    return null;
  },
  'memory:revokeActor': (input) => {
    learningTools.revokeActor(CodeMapHostContracts['memory:revokeActor'].params.parse(input).principal);
    return null;
  },
  'memory:archives': async (input) =>
    (await listArchives(CodeMapHostContracts['memory:archives'].params.parse(input).root)).map((checkoutId) => ({
      checkoutId,
      archived: true,
    })),
  'memory:archive': (input) => memory.archive(CodeMapHostContracts['memory:archive'].params.parse(input)),
  'memory:run': (input) => {
    const { authority, operation } = CodeMapHostContracts['memory:run'].params.parse(input);
    return memory.run(authority, operation);
  },
  'source:locate': (input) => checkouts.locateSource(CodeMapHostContracts['source:locate'].params.parse(input)),
  'instructions:edit': (input) => {
    const params = CodeMapHostContracts['instructions:edit'].params.parse(input);
    return checkouts.editInstructions(params.root, params.file, params.action);
  },
  'query:run': (input) => {
    const params = CodeMapHostContracts['query:run'].params.parse(input);
    return checkouts.query(params.checkoutId, params.requestId, params.query);
  },
  'query:cancel': (input) => {
    checkouts.cancelQuery(CodeMapHostContracts['query:cancel'].params.parse(input).requestId);
    return null;
  },
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
  'checkout:deleteData': (input) => {
    const params = CodeMapHostContracts['checkout:deleteData'].params.parse(input);
    return checkouts.deleteData(params.checkoutId, params.root);
  },
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
    await memory.dispose();
    await checkouts.dispose();
  },
  exit: (code) => process.exit(code),
});
// A stray rejected promise must not take the host down (every checkout would re-index after the restart). Logged
// instead; uncaught exceptions still end the process, which the supervisor restarts.
process.on('unhandledRejection', (reason) =>
  runtime.log.error('Unhandled promise rejection in the Code Map Host', reason),
);
runtime.log.info('Code Map Host started');
import { join, resolve } from 'node:path';
