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

interface Checkout {
  config: ConfigureCodeMapCheckout;
  status: CodeMapStatus;
  lease: OwnerLock | null;
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
    const checkout: Checkout = { config, status, lease: null };
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
    this.get(checkoutId);
    return { skipped: [], failed: [], unresolved: [], truncated: false };
  }
  pause(checkoutId: string): CodeMapStatus {
    const checkout = this.get(checkoutId);
    checkout.status.state = 'paused';
    return this.changed(checkout);
  }
  resume(checkoutId: string): CodeMapStatus {
    return this.pause(checkoutId);
  }
  rebuild(checkoutId: string): CodeMapStatus {
    return this.resume(checkoutId);
  }
  async remove(checkoutId: string): Promise<void> {
    return this.serialize(() => this.removeNow(checkoutId));
  }
  private async removeNow(checkoutId: string): Promise<void> {
    const checkout = this.checkouts.get(checkoutId);
    if (!checkout) return;
    this.checkouts.delete(checkoutId);
    await checkout.lease?.dispose();
  }
  async deleteData(checkoutId: string): Promise<CodeMapStatus> {
    return this.serialize(() => this.deleteDataNow(checkoutId));
  }
  private async deleteDataNow(checkoutId: string): Promise<CodeMapStatus> {
    const checkout = this.get(checkoutId);
    if (checkout.status.readOnly) throw new Error('Updated by another Oxytocin instance');
    await deleteMapData(checkout.config.root, checkout.lease ?? undefined);
    await this.removeNow(checkoutId);
    const status = initialCodeMapStatus(checkoutId);
    this.onStatus(status);
    return status;
  }
  async dispose(): Promise<void> {
    await this.serialize(async () => {
      for (const id of this.checkouts.keys()) await this.removeNow(id);
    });
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
