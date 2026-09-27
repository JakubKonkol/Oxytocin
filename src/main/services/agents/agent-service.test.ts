import { describe, expect, it } from 'vitest';
import type { TerminalInfo } from '@shared/domain/terminal';
import type { PtyHostEvents } from '@shared/rpc/contracts/pty-host';
import { toDisposable } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';
import type { TerminalRuntimePatch } from '../terminals/terminal-service';
import { AgentService, type AgentTerminalsPort } from './agent-service';
import type { RegistryEntry } from './claude-registry';

const silentLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

function setup(initial: Partial<TerminalInfo> = {}) {
  let now = 1_000_000;
  type Listener = (e: unknown, ports: readonly unknown[]) => void;
  const listeners = new Map<string, Set<Listener>>();
  const emit = <K extends keyof PtyHostEvents>(name: K, e: PtyHostEvents[K]) => {
    for (const l of listeners.get(name) ?? []) l(e, []);
  };
  const ptyHost = {
    onEvent: <K extends keyof PtyHostEvents>(
      name: K,
      listener: (e: PtyHostEvents[K], ports: readonly unknown[]) => void,
    ) => {
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set);
      set.add(listener as Listener);
      return toDisposable(() => set.delete(listener as Listener));
    },
  };
  const infos = new Map<string, TerminalInfo>();
  const updated = new Emitter<TerminalInfo>();
  const removed = new Emitter<string>();
  const terminals: AgentTerminalsPort = {
    get: (id) => infos.get(id),
    list: () => [...infos.values()],
    applyRuntime: (id: string, patch: TerminalRuntimePatch) => {
      const cur = infos.get(id);
      if (!cur) return;
      const next = { ...cur, ...patch };
      if (patch.agent === undefined && 'agent' in patch) delete next.agent;
      infos.set(id, next);
      updated.fire(next);
    },
    onDidUpdate: updated.event,
    onDidRemove: removed.event,
  };
  const regEntries = new Map<number, RegistryEntry>();
  const regChanged = new Emitter<void>();
  const registry = {
    get: (pid: number) => regEntries.get(pid),
    onDidChange: regChanged.event,
    hasClaudeAgents: false,
    rescan: () => Promise.resolve(),
  };
  const service = new AgentService({ ptyHost, terminals, registry, logger: silentLogger, now: () => now, tickMs: 0 });
  const info: TerminalInfo = {
    id: 't1',
    projectId: 'p1',
    profileId: 'bash',
    profileName: 'bash',
    title: 'bash',
    pid: 100,
    cwd: '/',
    shellType: 'bash',
    kind: 'shell',
    state: 'running',
    createdAt: now,
    envStale: false,
    bell: false,
    ...initial,
  };
  infos.set(info.id, info);
  updated.fire(info);
  const claude = {
    pid: 200,
    ppid: 100,
    name: 'node',
    commandLine: 'node /x/node_modules/@anthropic-ai/claude-code/cli.js',
  };
  return {
    service,
    emit,
    registry,
    regEntries,
    regChanged,
    claude,
    info: () => infos.get('t1')!,
    advance: (ms: number) => {
      now += ms;
      service.tick();
    },
  };
}

describe('AgentService', () => {
  it('classifies shell, process and agent terminals from process reports', () => {
    const s = setup();
    s.emit('terminal:process', {
      id: 't1',
      descendants: [{ pid: 150, ppid: 100, name: 'npm', commandLine: 'npm run dev' }],
    });
    // A plain process must survive 1 s (shell start-up helpers never show up as PROCESS).
    expect(s.info().kind).toBe('shell');
    s.advance(1_000);
    expect(s.info().kind).toBe('process');
    expect(s.info().foreground?.name).toBe('npm');
    s.emit('terminal:process', { id: 't1', descendants: [s.claude] });
    expect(s.info().kind).toBe('agent');
    expect(s.info().agent).toMatchObject({ agentId: 'claude-code', pid: 200, state: 'unknown' });
    expect(s.service.list()).toHaveLength(1);
    expect(s.registry.hasClaudeAgents).toBe(true);
    s.emit('terminal:process', { id: 't1', descendants: [] });
    expect(s.info().kind).toBe('shell');
    expect(s.info().agent).toBeUndefined();
    expect(s.info().foreground).toBeUndefined();
    expect(s.service.list()).toHaveLength(0);
  });

  it('ignores short-lived helper processes', () => {
    const s = setup();
    s.emit('terminal:process', {
      id: 't1',
      descendants: [{ pid: 150, ppid: 100, name: 'dircolors', commandLine: 'dircolors' }],
    });
    s.advance(300);
    s.emit('terminal:process', { id: 't1', descendants: [] });
    s.advance(2_000);
    expect(s.info().kind).toBe('shell');
  });

  it('uses shell integration command boundaries: immediate PROCESS, prompt helpers ignored', () => {
    const s = setup();
    const npm = { pid: 150, ppid: 100, name: 'npm', commandLine: 'npm test' };
    // At the prompt: a helper run by the prompt never makes the terminal a PROCESS.
    s.emit('terminal:command', { id: 't1', phase: 'prompt' });
    s.emit('terminal:process', { id: 't1', descendants: [{ ...npm, name: 'git', commandLine: 'git status' }] });
    s.advance(2_000);
    expect(s.info().kind).toBe('shell');
    // A command started: PROCESS without the 1 s confirmation.
    s.emit('terminal:command', { id: 't1', phase: 'start', commandLine: 'npm test' });
    s.emit('terminal:process', { id: 't1', descendants: [npm] });
    expect(s.info().kind).toBe('process');
    expect(s.info().foreground?.name).toBe('npm');
    // It ended: back to SHELL at once, even if the process report lags behind.
    s.emit('terminal:command', { id: 't1', phase: 'end', exitCode: 0, durationMs: 10 });
    expect(s.info().kind).toBe('shell');
    expect(s.info().foreground).toBeUndefined();
    s.emit('terminal:process', { id: 't1', descendants: [npm] });
    s.advance(2_000);
    expect(s.info().kind).toBe('shell');
    // A subshell of the shell's hooks sampled at the command start is not confirmed instantly.
    s.emit('terminal:command', { id: 't1', phase: 'start', commandLine: 'make' });
    s.emit('terminal:process', {
      id: 't1',
      descendants: [{ ...npm, pid: 160, name: 'bash', commandLine: 'bash --init-file x' }],
    });
    expect(s.info().kind).toBe('shell');
    s.emit('terminal:process', { id: 't1', descendants: [{ ...npm, pid: 170, name: 'make', commandLine: 'make' }] });
    expect(s.info().kind).toBe('process');
    expect(s.info().foreground?.name).toBe('make');
    s.emit('terminal:command', { id: 't1', phase: 'end', exitCode: 0, durationMs: 10 });
    // Agents are still detected while a command runs.
    s.emit('terminal:command', { id: 't1', phase: 'start', commandLine: 'claude' });
    s.emit('terminal:process', { id: 't1', descendants: [s.claude] });
    expect(s.info().kind).toBe('agent');
  });

  it('keeps agent-profile terminals "starting" until detection, at most 10 s', () => {
    const s = setup({ kind: 'agent', profileId: 'agent:claude', profileName: 'Claude Code' });
    expect(s.info().agent).toMatchObject({ agentId: 'claude-code', state: 'starting' });
    s.emit('terminal:process', { id: 't1', descendants: [] });
    expect(s.info().agent?.state).toBe('starting');
    s.advance(10_001);
    expect(s.info().kind).toBe('shell');
    expect(s.info().agent).toBeUndefined();
  });

  it('hook reports (Claude Code Bridge) win over the registry for 10 s and set the session id', () => {
    const s = setup();
    s.regEntries.set(200, { pid: 200, status: 'idle', sessionId: 'from-registry' });
    s.emit('terminal:process', { id: 't1', descendants: [s.claude] });
    expect(s.info().agent).toMatchObject({ state: 'idle', stateSource: 'claude-registry' });
    s.service.reportState('t1', { state: 'working', sessionId: 'from-hook' });
    expect(s.info().agent).toMatchObject({ state: 'working', stateSource: 'hook', sessionId: 'from-hook' });
    // The registry lags behind: ignored inside the window.
    s.regChanged.fire();
    expect(s.info().agent).toMatchObject({ state: 'working', stateSource: 'hook' });
    s.service.reportState('t1', { state: 'waiting', waitingFor: 'tool permission' });
    expect(s.info().agent).toMatchObject({ state: 'waiting', waitingFor: 'tool permission' });
    s.advance(10_001);
    s.regChanged.fire();
    expect(s.info().agent).toMatchObject({ state: 'idle', stateSource: 'claude-registry' });
    // No agent in the terminal: nothing happens.
    s.service.reportState('nope', { state: 'working' });
  });

  it('follows the Claude registry by pid', () => {
    const s = setup();
    s.regEntries.set(200, { pid: 200, status: 'busy', sessionId: 's1', name: 'Fix tests' });
    s.emit('terminal:process', { id: 't1', descendants: [s.claude] });
    expect(s.info().agent).toMatchObject({
      state: 'working',
      stateSource: 'claude-registry',
      sessionId: 's1',
      sessionName: 'Fix tests',
    });
    s.regEntries.set(200, { pid: 200, status: 'waiting', waitingFor: 'permission' });
    s.regChanged.fire();
    expect(s.info().agent).toMatchObject({ state: 'waiting', waitingFor: 'permission' });
    s.regEntries.set(200, { pid: 200, status: 'idle' });
    s.regChanged.fire();
    expect(s.info().agent?.state).toBe('idle');
    expect(s.info().agent?.waitingFor).toBeUndefined();
  });

  it('REPRO bell then registry waiting', () => {
    const s = setup();
    s.regEntries.set(200, { pid: 200, status: 'idle' });
    s.emit('terminal:process', { id: 't1', descendants: [s.claude] });
    s.regEntries.set(200, { pid: 200, status: 'busy' });
    s.regChanged.fire();
    s.emit('terminal:progress', { id: 't1', state: 3 });
    s.advance(200);
    s.emit('terminal:bell', { id: 't1' });
    s.regEntries.set(200, { pid: 200, status: 'waiting', waitingFor: 'permission' });
    s.regChanged.fire();
    expect(s.info().agent?.state).toBe('waiting');
  });

  it('lower-priority sources cannot override a higher one for 10 s', () => {
    const s = setup();
    s.regEntries.set(200, { pid: 200, status: 'idle' });
    s.emit('terminal:process', { id: 't1', descendants: [s.claude] });
    s.emit('terminal:progress', { id: 't1', state: 3 });
    expect(s.info().agent?.state).toBe('idle');
    s.advance(10_001);
    s.emit('terminal:progress', { id: 't1', state: 3 });
    expect(s.info().agent).toMatchObject({ state: 'working', stateSource: 'osc-progress' });
  });

  it('uses OSC 9;4 progress and bells, and leaves "waiting" on user input', () => {
    const s = setup();
    s.emit('terminal:process', { id: 't1', descendants: [s.claude] });
    s.emit('terminal:progress', { id: 't1', state: 0 });
    expect(s.info().agent?.state).toBe('unknown'); // 0 without prior work means nothing
    s.emit('terminal:progress', { id: 't1', state: 3 });
    expect(s.info().agent?.state).toBe('working');
    s.advance(11_000);
    s.emit('terminal:bell', { id: 't1' });
    expect(s.info().agent).toMatchObject({ state: 'waiting', stateSource: 'bell' });
    s.emit('terminal:userInput', { id: 't1' });
    expect(s.info().agent?.state).toBe('working');
    s.emit('terminal:progress', { id: 't1', state: 0 });
    expect(s.info().agent?.state).toBe('idle');
  });

  it('falls back to output heuristics when no precise source exists', () => {
    const s = setup();
    s.emit('terminal:process', {
      id: 't1',
      descendants: [{ pid: 300, ppid: 100, name: 'aider', commandLine: 'aider' }],
    });
    s.emit('terminal:activity', { id: 't1', lastOutputAt: 1_000_000 });
    s.advance(500);
    expect(s.info().agent).toMatchObject({ agentId: 'aider', state: 'working', stateSource: 'output-heuristic' });
    s.advance(5_000);
    expect(s.info().agent?.state).toBe('working');
    s.advance(4_000);
    expect(s.info().agent?.state).toBe('idle');
  });

  it('drops the agent when the terminal exits', () => {
    const s = setup();
    s.emit('terminal:process', { id: 't1', descendants: [s.claude] });
    s.emit('terminal:exit', { id: 't1', exitCode: 0 });
    expect(s.info().agent).toBeUndefined();
    expect(s.service.list()).toHaveLength(0);
  });
});
