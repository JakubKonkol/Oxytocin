import { realpath } from 'node:fs/promises';
import {
  CODE_MAP_LIMITS,
  CodeMapStatusSchema,
  emptyCodeMapCoverage,
  type CodeMapDiagnostics,
  type CodeMapStatus,
} from '@shared/domain/code-map';
import { ConfigureCodeMapCheckoutSchema, type ConfigureCodeMapCheckout } from '@shared/rpc/contracts/code-map-host';
import { deleteMapData, prepareOxyDirectory } from './store/oxy-dir';
import { loadSnapshot } from './store/writer';
import type { OwnerLock } from './store/owner-lock';
import { CheckoutIndexer } from './indexer';
import { CodeMapScheduler } from './scheduler';
import { CodeMapLimitError } from './enumerate';

interface Checkout {
  config: ConfigureCodeMapCheckout;
  status: CodeMapStatus;
  lease: OwnerLock | null;
  indexer?: CheckoutIndexer;
  diagnostics: CodeMapDiagnostics;
}

export function initialCodeMapStatus(checkoutId: string): CodeMapStatus {
  return {
    checkoutId,
    state: 'disabled',
    generation: 0,
    progress: null,
    counts: { files: 0, symbols: 0, edges: 0 },
    coverage: emptyCodeMapCoverage(),
    languages: {},
    updatedAt: null,
    bytes: 0,
    pendingFiles: 0,
    error: null,
    owner: null,
    readOnly: false,
    limits: { ...CODE_MAP_LIMITS },
  };
}

/** Host-owned checkout lifetimes. Parsing and scheduling are added in subsequent internal stages. */
export class CodeMapCheckouts {
  private readonly checkouts = new Map<string, Checkout>();
  private mutation: Promise<unknown> = Promise.resolve();
  private readonly scheduler = new CodeMapScheduler();
  constructor(
    private readonly app: string,
    private readonly onStatus: (status: CodeMapStatus) => void,
  ) {}

  async configure(input: unknown): Promise<CodeMapStatus> {
    return this.serialize(() => this.configureNow(input));
  }
  private async configureNow(input: unknown): Promise<CodeMapStatus> {
    const config = ConfigureCodeMapCheckoutSchema.parse(input);
    config.root = await realpath(config.root);
    await this.removeNow(config.checkoutId);
    const status = initialCodeMapStatus(config.checkoutId);
    const checkout: Checkout = {
      config,
      status,
      lease: null,
      diagnostics: { skipped: [], failed: [], unresolved: [], truncated: false },
    };
    this.checkouts.set(config.checkoutId, checkout);
    try {
      const prepared = await prepareOxyDirectory({ ...config, app: this.app });
      checkout.lease = prepared.lease;
      status.owner = prepared.owner;
      status.readOnly = !prepared.lease;
      status.error = prepared.warning;
      const snapshot = await loadSnapshot(prepared.directory);
      if (snapshot) {
        status.generation = snapshot.manifest.generation;
        status.counts = snapshot.manifest.counts;
        status.coverage = snapshot.graph.coverage;
        status.updatedAt = snapshot.manifest.builtAt;
      }
      status.state = prepared.warning && !status.readOnly ? 'error' : 'paused';
      if (prepared.lease) {
        checkout.indexer = new CheckoutIndexer({
          ...config,
          scheduler: this.scheduler,
          hooks: {
            start: (total) => {
              status.progress = { completed: 0, total };
              if (!status.error) status.state = status.generation ? 'updating' : 'indexing';
              this.changed(checkout);
            },
            file: () => {
              if (status.progress) status.progress.completed++;
            },
            removed: () => undefined,
            failed: () => undefined,
            pending: (count) => {
              status.pendingFiles = count;
              if (status.state === 'ready') status.state = 'updating';
              this.changed(checkout);
            },
            complete: (inventory) => {
              checkout.diagnostics = inventory.diagnostics;
              status.counts.files = inventory.files.size;
              status.coverage.files = {
                indexed: inventory.files.size,
                unsupported: 0,
                skipped: inventory.skippedCount,
                failed: inventory.diagnostics.failed.length,
              };
              status.progress = null;
              status.pendingFiles = 0;
              status.state = status.error ? 'error' : 'ready';
              this.changed(checkout);
            },
            error: (error) => {
              status.state = error instanceof CodeMapLimitError ? 'limit' : 'error';
              status.progress = null;
              status.error = error instanceof Error ? error.message : String(error);
              this.changed(checkout);
            },
          },
        });
        status.state = status.error ? 'error' : 'indexing';
        await checkout.indexer.start();
      }
    } catch (error) {
      status.state = 'error';
      status.error = error instanceof Error ? error.message : String(error);
    }
    return this.changed(checkout);
  }
  status(checkoutId: string): CodeMapStatus {
    return CodeMapStatusSchema.parse(this.get(checkoutId).status);
  }
  diagnostics(checkoutId: string): CodeMapDiagnostics {
    return structuredClone(this.get(checkoutId).diagnostics);
  }
  pause(checkoutId: string): CodeMapStatus {
    const checkout = this.get(checkoutId);
    checkout.indexer?.pause();
    checkout.status.state = 'paused';
    return this.changed(checkout);
  }
  resume(checkoutId: string): CodeMapStatus {
    const checkout = this.get(checkoutId);
    checkout.indexer?.resume();
    if (!checkout.status.readOnly) checkout.status.state = 'updating';
    return this.changed(checkout);
  }
  rebuild(checkoutId: string): CodeMapStatus {
    this.get(checkoutId).indexer?.rebuild();
    return this.resume(checkoutId);
  }
  async remove(checkoutId: string): Promise<void> {
    return this.serialize(() => this.removeNow(checkoutId));
  }
  private async removeNow(checkoutId: string): Promise<void> {
    const checkout = this.checkouts.get(checkoutId);
    if (!checkout) return;
    await checkout.indexer?.dispose();
    await checkout.lease?.dispose();
    this.checkouts.delete(checkoutId);
  }
  async deleteData(checkoutId: string): Promise<CodeMapStatus> {
    return this.serialize(() => this.deleteDataNow(checkoutId));
  }
  private async deleteDataNow(checkoutId: string): Promise<CodeMapStatus> {
    const checkout = this.get(checkoutId);
    if (checkout.status.readOnly) throw new Error('Updated by another Oxytocin instance');
    await checkout.indexer?.dispose();
    await deleteMapData(checkout.config.root, checkout.lease ?? undefined);
    await this.removeNow(checkoutId);
    const status = initialCodeMapStatus(checkoutId);
    this.onStatus(status);
    return status;
  }
  async dispose(): Promise<void> {
    await this.serialize(async () => {
      for (const id of this.checkouts.keys()) await this.removeNow(id);
      this.scheduler.dispose();
    });
  }
  hints(hints: { activeProjectId: string | null; terminalProjectIds: string[]; reconcile: boolean }): void {
    this.scheduler.hints(hints.activeProjectId, hints.terminalProjectIds);
    if (hints.reconcile) for (const checkout of this.checkouts.values()) checkout.indexer?.reconcileSoon(true);
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation);
    this.mutation = result.catch(() => undefined);
    return result;
  }
  private get(checkoutId: string): Checkout {
    const checkout = this.checkouts.get(checkoutId);
    if (!checkout) throw new Error('Unknown Code Map checkout');
    return checkout;
  }
  private changed(checkout: Checkout): CodeMapStatus {
    const status = this.status(checkout.config.checkoutId);
    this.onStatus(status);
    return status;
  }
}
