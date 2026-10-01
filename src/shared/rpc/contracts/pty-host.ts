import type { ProcInfo, ProgressState, SpawnOptions, TerminalId } from '../../domain/terminal';
import type { HostBaseEvents, HostBaseMethods } from './host-base';

export interface PtyTerminalListEntry {
  id: TerminalId;
  pid: number;
  alive: boolean;
}

export type PtyHostMethods = HostBaseMethods & {
  spawn: (o: SpawnOptions) => { pid: number };
  write: (o: { id: TerminalId; data: string }) => void;
  /** Types a message into the program: bracketed paste when it turned that on, then Enter with `submit`. */
  paste: (o: { id: TerminalId; text: string; submit?: boolean }) => { bracketed: boolean };
  resize: (o: { id: TerminalId; cols: number; rows: number }) => void;
  /** force → kill the whole process tree immediately; otherwise a graceful kill with a 3 s tree-kill fallback. */
  kill: (o: { id: TerminalId; force?: boolean }) => void;
  /** Releases the mirror of an exited terminal. */
  dispose: (o: { id: TerminalId }) => void;
  list: (p: null) => PtyTerminalListEntry[];
  serialize: (o: { id: TerminalId; scrollback?: number }) => { seq: number; data: string };
  setScrollback: (o: { scrollback: number }) => void;
  /** Plain text of the mirror (diagnostics and E2E tests). */
  getText: (o: { id: TerminalId }) => string;
  /** Emits the terminal's output as `terminal:output` events while `watch` is on. */
  watchOutput: (o: { id: TerminalId; watch: boolean }) => void;
  /** TCP ports the terminal's processes (the shell and its descendants) listen on, ascending. */
  listeningPorts: (o: { id: TerminalId }) => number[];
};

export type PtyHostEvents = HostBaseEvents & {
  'terminal:exit': { id: TerminalId; exitCode: number; signal?: number };
  'terminal:title': { id: TerminalId; title: string };
  'terminal:bell': { id: TerminalId };
  'terminal:progress': { id: TerminalId; state: ProgressState; value?: number };
  'terminal:notification': { id: TerminalId; title?: string; body: string };
  'terminal:cwd': { id: TerminalId; cwd: string };
  /**
   * Shell integration (OSC 633, 04 §11): `prompt` at each prompt, `start` when a command runs, `end` when it
   * finished (exit code when the shell reported one; `interrupted` when Ctrl+C was typed while it ran).
   */
  'terminal:command': {
    id: TerminalId;
    phase: 'prompt' | 'start' | 'end';
    commandLine?: string;
    exitCode?: number;
    durationMs?: number;
    interrupted?: boolean;
  };
  'terminal:activity': { id: TerminalId; lastOutputAt: number };
  'terminal:process': { id: TerminalId; descendants: ProcInfo[]; foreground?: ProcInfo };
  /** The user submitted input (Enter) — used to move an agent out of "waiting". Throttled to 1/s. */
  'terminal:userInput': { id: TerminalId };
  /** Output of a watched terminal (`watchOutput`), in the renderer's batches. */
  'terminal:output': { id: TerminalId; data: string };
};

/** Events main sends to the PTY Host. */
export type PtyHostInboundEvents = {
  /** A MessagePort (transferred) for a renderer window; replaces the previous port of that window. */
  'renderer-port': { windowId: number };
};
