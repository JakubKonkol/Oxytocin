import { realpath } from 'node:fs/promises';
import {
  initialCodeMapStatus,
  CodeMapStatusSchema,
  type CodeMapDiagnostics,
  type CodeMapStatus,
} from '@shared/domain/code-map';
import { ConfigureCodeMapCheckoutSchema, type ConfigureCodeMapCheckout } from '@shared/rpc/contracts/code-map-host';
import { deleteMapData, prepareOxyDirectory } from './store/oxy-dir';
import type { OwnerLock } from './store/owner-lock';
import { CheckoutIndexer } from './indexer';
import { CodeMapScheduler } from './scheduler';
import { CodeMapLimitError } from './enumerate';
import { GraphEngine } from './graph/engine';
import { ParserClient } from './parse/client';
import { hasCode } from './store/paths';
import { isMapGitIgnored } from './store/gitignore';
import { dataSize } from './store/writer';

export { initialCodeMapStatus } from '@shared/domain/code-map';

interface Checkout {
  config: ConfigureCodeMapCheckout;
  status: CodeMapStatus;
  lease: OwnerLock | null;
  indexer?: CheckoutIndexer;
  diagnostics: CodeMapDiagnostics;
  graph?: GraphEngine;
  warning: string | null;
}

/** Host-owned checkout lifetimes. Parsing and scheduling are added in subsequent internal stages. */
export class CodeMapCheckouts {
  private readonly checkouts = new Map<string, Checkout>();
  private mutation: Promise<unknown> = Promise.resolve();
  private readonly scheduler = new CodeMapScheduler();
  private readonly parser: Pick<ParserClient, 'parse' | 'dispose'>;
  constructor(
    private readonly app: string,
    private readonly onStatus: (status: CodeMapStatus) => void,
    private readonly runtime: { assets: string; parserEntry: string; parser?: Pick<ParserClient, 'parse' | 'dispose'> },
  ) {
    this.parser = runtime.parser ?? new ParserClient(runtime.parserEntry, runtime.assets);
  }

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
      warning: null,
    };
    this.checkouts.set(config.checkoutId, checkout);
    try {
      const prepared = await prepareOxyDirectory({ ...config, app: this.app });
      checkout.lease = prepared.lease;
      status.owner = prepared.owner;
      status.readOnly = !prepared.lease;
      status.gitIgnored = await isMapGitIgnored(config.root, config.gitPath);
      status.error = prepared.warning;
      checkout.warning = prepared.warning;
      checkout.graph = new GraphEngine({
        root: config.root,
        assets: this.runtime.assets,
        version: this.app.replace(/^Oxytocin /, ''),
        excludedPaths: config.excludedPaths,
        parser: this.parser,
        assertOwned: async () => {
          if (!checkout.lease) throw new Error('Updated by another Oxytocin instance');
          await checkout.lease.assertOwned();
        },
      });
      await checkout.graph.initialize();
      const snapshot = checkout.graph.snapshot();
      if (snapshot) {
        status.generation = snapshot.manifest.generation;
        status.counts = snapshot.manifest.counts;
        status.coverage = snapshot.graph.coverage;
        status.updatedAt = snapshot.manifest.builtAt;
        status.bytes = await dataSize(prepared.directory);
        status.languages = languageSupport(status.coverage.byLanguage);
      }
      status.state = prepared.warning && !status.readOnly ? 'error' : 'paused';
      if (prepared.lease) {
        checkout.indexer = new CheckoutIndexer({
          ...config,
          scheduler: this.scheduler,
          hooks: {
            start: (total) => {
              checkout.graph!.start();
              status.error = checkout.warning;
              status.progress = { completed: 0, total };
              if (!status.error) status.state = status.generation ? 'updating' : 'indexing';
              this.changed(checkout);
            },
            file: async (path, _, source, signal) => {
              if (status.progress) status.progress.completed++;
              this.changed(checkout);
              return checkout.graph!.file(path, source, signal);
            },
            removed: (path) => checkout.graph!.removed(path),
            failed: (path, reason) => checkout.graph!.failed(path, reason),
            pending: (count) => {
              status.pendingFiles = count;
              if (status.state === 'ready') status.state = 'updating';
              this.changed(checkout);
            },
            complete: async (inventory, signal) => {
              const published = await checkout.graph!.complete(inventory, signal);
              signal.throwIfAborted();
              checkout.diagnostics = published.diagnostics;
              status.counts = published.manifest.counts;
              status.coverage = published.graph.coverage;
              status.generation = published.manifest.generation;
              status.updatedAt = published.manifest.builtAt;
              status.bytes = published.bytes;
              status.languages = languageSupport(status.coverage.byLanguage);
              status.progress = null;
              status.pendingFiles = checkout.indexer?.pendingFiles ?? 0;
              status.state = status.error ? 'error' : status.pendingFiles ? 'updating' : published.manifest.state;
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
    this.get(checkoutId).graph?.rebuild();
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
    checkout.graph?.dispose();
    await checkout.lease?.dispose();
    this.checkouts.delete(checkoutId);
  }
  async deleteData(checkoutId: string, root?: string): Promise<CodeMapStatus> {
    return this.serialize(() => this.deleteDataNow(checkoutId, root));
  }
  private async deleteDataNow(checkoutId: string, root?: string): Promise<CodeMapStatus> {
    const checkout = this.checkouts.get(checkoutId);
    if (!checkout) {
      if (!root) throw new Error('Unknown Code Map checkout');
      await deleteMapData(root).catch((error: unknown) => {
        if (!hasCode(error, 'ENOENT')) throw error;
      });
      const status = initialCodeMapStatus(checkoutId);
      this.onStatus(status);
      return status;
    }
    if (root && (await realpath(root)) !== checkout.config.root) throw new Error('Checkout root changed');
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
      await this.parser.dispose();
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

function languageSupport(languages: Record<string, number>): CodeMapStatus['languages'] {
  return Object.fromEntries(
    Object.keys(languages).map((language) => [
      language,
      {
        level: ['typescript', 'javascript'].includes(language) ? 'Calls' : 'Files',
        description: ['typescript', 'javascript'].includes(language)
          ? 'Syntax and lexical bindings; unknown receiver types remain unresolved.'
          : 'File metadata only.',
      },
    ]),
  );
}
