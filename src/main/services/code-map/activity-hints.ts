import type { Logger } from '@shared/logging/logger';
import type { CodeMapHostEvents, CodeMapHostMethods } from '@shared/rpc/contracts/code-map-host';
import { DisposableStore, type Disposable } from '@shared/utils/disposable';
import type { UtilityHost } from '../../hosts/utility-host';

/** Sends compact scheduling facts; it never starts a host or indexes a path. */
export class CodeMapActivityHints implements Disposable {
  private readonly subscriptions = new DisposableStore();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly options: {
      host: Pick<UtilityHost<CodeMapHostMethods, CodeMapHostEvents>, 'state' | 'call' | 'onDidBecomeReady'>;
      current(): { activeProjectId: string | null; terminalProjectIds: string[] };
      subscribe(changed: () => void): Disposable[];
      logger: Logger;
    },
  ) {
    this.subscriptions.add(options.host.onDidBecomeReady(() => this.reconcile()));
    for (const subscription of options.subscribe(() => this.schedule())) this.subscriptions.add(subscription);
  }
  private schedule(): void {
    if (this.options.host.state !== 'running' || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.send(false);
    }, 100);
  }
  private send(reconcile: boolean): void {
    if (this.options.host.state !== 'running') return;
    void this.options.host
      .call('hints:update', { ...this.options.current(), reconcile })
      .catch((error: unknown) => this.options.logger.warn('Could not send Code Map activity hints', error));
  }
  reconcile(): void {
    this.send(true);
  }
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.subscriptions.dispose();
  }
}
