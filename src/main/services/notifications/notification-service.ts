import type { Settings } from '@shared/domain/settings';
import type { TerminalInfo } from '@shared/domain/terminal';
import type { NotificationPayload } from '@shared/ipc/events';
import { type Disposable, DisposableStore } from '@shared/utils/disposable';

export interface NotificationTarget {
  projectId: string;
  terminalId: string;
}

export interface NotificationServiceDeps {
  terminals: {
    get(id: string): TerminalInfo | undefined;
    onDidUpdate: (listener: (info: TerminalInfo) => void) => Disposable;
    onDidRemove: (listener: (id: string) => void) => Disposable;
  };
  settings: () => Settings;
  projectName: (projectId: string) => string | undefined;
  /** In-app toast in the renderer (skipped there when the target terminal is visible). */
  toast: (payload: NotificationPayload) => void;
  window: {
    isFocused(): boolean;
    flash(on: boolean): void;
  };
  /** OS notification; `onClick` reveals the terminal. */
  osNotify: (n: { title: string; body: string; onClick: () => void }) => void;
  reveal: (target: NotificationTarget) => void;
  now?: () => number;
}

interface Last {
  state: TerminalInfo['state'];
  lastCommandAt?: number;
  agentState?: string;
  workingSince?: number;
}

/** Attention system (docs/plan/02-ui-ux.md §9): toasts, OS notifications and taskbar flashing on transitions. */
export class NotificationService implements Disposable {
  private readonly last = new Map<string, Last>();
  private readonly store = new DisposableStore();
  private readonly now: () => number;

  constructor(private readonly deps: NotificationServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.store.add(deps.terminals.onDidUpdate((info) => this.onUpdate(info)));
    this.store.add(deps.terminals.onDidRemove((id) => this.last.delete(id)));
  }

  /** The window got focus: stop flashing. */
  onWindowFocus(): void {
    this.deps.window.flash(false);
  }

  private onUpdate(info: TerminalInfo): void {
    const prev = this.last.get(info.id);
    const agentState = info.agent?.state;
    const next: Last = {
      state: info.state,
      ...(agentState ? { agentState } : {}),
      ...(info.lastCommand ? { lastCommandAt: info.lastCommand.finishedAt } : {}),
    };
    if (agentState === 'working') next.workingSince = prev?.agentState === 'working' ? prev.workingSince : this.now();
    this.last.set(info.id, next);
    if (!prev) return;

    const s = this.deps.settings();
    const target = { projectId: info.projectId, terminalId: info.id };
    const where = [this.deps.projectName(info.projectId), info.title].filter(Boolean).join(' · ');
    const name = info.agent?.displayName ?? info.title;

    if (agentState === 'waiting' && prev.agentState !== 'waiting' && s['notifications.agentWaiting']) {
      const what = info.agent?.waitingFor === 'permission' ? 'is waiting for tool permission' : 'is waiting for you';
      this.deps.toast({ kind: 'warning', message: `${name} ${what}`, description: where, target, onlyIfHidden: true });
      this.attention(`${name} ${what}`, where, target, true);
      return;
    }
    if (
      agentState === 'idle' &&
      prev.agentState === 'working' &&
      prev.workingSince !== undefined &&
      this.now() - prev.workingSince >= s['notifications.agentFinishedMinSeconds'] * 1000
    ) {
      this.deps.toast({ kind: 'success', message: `${name} finished`, description: where, target, onlyIfHidden: true });
      if (s['notifications.agentFinished']) this.attention(`${name} finished`, where, target, false);
      return;
    }
    const cmd = info.lastCommand;
    if (
      cmd &&
      cmd.finishedAt !== prev.lastCommandAt &&
      info.kind !== 'agent' &&
      s['notifications.commandFinished'] &&
      cmd.durationMs >= s['notifications.commandFinishedMinSeconds'] * 1000
    ) {
      const failed = cmd.exitCode !== undefined && cmd.exitCode !== 0;
      const title = failed ? `Command failed (exit ${cmd.exitCode})` : 'Command finished';
      const body = [cmd.commandLine, where].filter(Boolean).join(' · ');
      this.deps.toast({
        kind: failed ? 'error' : 'success',
        message: title,
        description: body,
        target,
        onlyIfHidden: true,
      });
      this.attention(title, body, target, false);
      return;
    }
    if (
      prev.state === 'running' &&
      info.state === 'exited' &&
      (info.exitCode ?? 0) !== 0 &&
      s['notifications.processError']
    ) {
      this.deps.toast({
        kind: 'error',
        message: `Process exited with code ${info.exitCode}`,
        description: where,
        target,
        onlyIfHidden: true,
      });
    }
  }

  /** OS notification (+ taskbar flash) when the window is not focused. */
  private attention(title: string, body: string, target: NotificationTarget, flash: boolean): void {
    if (this.deps.window.isFocused()) return;
    const s = this.deps.settings();
    if (flash && s['notifications.flashTaskbar']) this.deps.window.flash(true);
    if (!s['notifications.os'] || s['notifications.doNotDisturb']) return;
    this.deps.osNotify({ title, body, onClick: () => this.deps.reveal(target) });
  }

  dispose(): void {
    this.store.dispose();
  }
}
