import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { CodeMapGraph } from '@shared/domain/code-map';
import type { Learning, LearningOperation, LearningResult, MemoryAuthority } from '@shared/domain/code-map-memory';
import { LearningOperationSchema, LearningResultSchema, MemoryAuthoritySchema } from '@shared/domain/code-map-memory';
import { OwnerLock } from '../store/owner-lock';
import { hasCode, safeDirectory } from '../store/paths';
import { sha256 } from '../store/writer';
import { checkApplicability, evidenceFor } from './applicability';
import { emptyMemory, loadMemory, MEMORY_BYTES, writeMemory, type MemoryFile } from './store';
import { memoryLocations, type MemoryLocation } from './locations';
import { EvidenceObservation } from './observation';
import type { WatchSubscribe } from '../watch';
import { commitMemory, replayTransaction } from './transaction';
import { LearningFeedbackMutationSchema, type LearningFeedbackMutation } from '@shared/domain/code-map-learning-tools';

const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
function dedupKey(
  draft: Pick<Learning, 'kind' | 'title' | 'body' | 'evidence'>,
  scope: Learning['scope'],
  scopeId: string,
): string {
  return sha256(
    JSON.stringify([
      scope,
      scopeId,
      draft.kind,
      normalize(draft.title),
      normalize(draft.body),
      draft.evidence.map((e) => [e.path, e.symbolId ?? '', e.span ?? []]).sort(),
    ]),
  );
}
async function acquireLease(directory: string): Promise<OwnerLock> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const { lease } = await OwnerLock.acquire(directory, 'Oxytocin Learnings');
    if (lease) return lease;
    await delay(25);
  }
  throw new Error('MEMORY_BUSY: updated by another Oxytocin instance; retry shortly');
}
export class LearningMemory {
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  readonly observation: EvidenceObservation;
  constructor(
    private readonly snapshot: (checkoutId: string) => { graph: CodeMapGraph; generation: number } | undefined,
    subscribe?: WatchSubscribe,
    private readonly changed?: (projectId: string, checkoutId: string, memoryRevision: number) => void,
  ) {
    this.observation = new EvidenceObservation(subscribe);
  }
  async dispose(): Promise<void> {
    // Operations queued from now on (a watcher event while the queue drains) end without touching the checkout, so
    // they cannot start a new evidence watcher after the watchers are closed.
    this.disposed = true;
    await this.queue;
    await this.observation.dispose();
  }
  archive(authority: MemoryAuthority): Promise<LearningResult> {
    const next = this.queue.then(() => this.execute(MemoryAuthoritySchema.parse(authority), { action: 'archive' }));
    this.queue = next.catch(() => undefined);
    return next;
  }

  context(authority: MemoryAuthority, signal?: AbortSignal): Promise<LearningResult> {
    return this.enqueueInternal(authority, { action: 'context' }, signal);
  }
  inspect(authority: MemoryAuthority, signal?: AbortSignal): Promise<LearningResult> {
    return this.enqueueInternal(authority, { action: 'inspect' }, signal);
  }
  feedback(
    authority: MemoryAuthority,
    operation: LearningFeedbackMutation,
    signal?: AbortSignal,
  ): Promise<LearningResult> {
    return this.enqueueInternal(authority, LearningFeedbackMutationSchema.parse(operation), signal);
  }
  private enqueueInternal(
    authority: MemoryAuthority,
    operation: LearningOperation | LearningFeedbackMutation | { action: 'context' } | { action: 'inspect' },
    signal?: AbortSignal,
  ): Promise<LearningResult> {
    const next = this.queue.then(() => this.execute(MemoryAuthoritySchema.parse(authority), operation, signal));
    this.queue = next.catch(() => undefined);
    return next;
  }
  run(authority: MemoryAuthority, operation: LearningOperation, signal?: AbortSignal): Promise<LearningResult> {
    const next = this.queue.then(() =>
      this.execute(MemoryAuthoritySchema.parse(authority), LearningOperationSchema.parse(operation), signal),
    );
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async execute(
    authority: MemoryAuthority,
    operation:
      | LearningOperation
      | LearningFeedbackMutation
      | { action: 'archive' }
      | { action: 'context' }
      | { action: 'inspect' },
    signal?: AbortSignal,
  ): Promise<LearningResult> {
    if (this.disposed) throw new Error('UNAVAILABLE: Code Map memory closed');
    signal?.throwIfAborted();
    if (
      authority.origin.source !== 'user' &&
      operation.action !== 'save' &&
      operation.action !== 'list' &&
      operation.action !== 'get' &&
      operation.action !== 'context' &&
      operation.action !== 'feedback'
    )
      throw new Error('FORBIDDEN: user operation');
    if (authority.archived && !['get', 'list', 'export', 'delete', 'forget', 'review'].includes(operation.action))
      throw new Error('ARCHIVED_CHECKOUT: inspect or promote archived learnings');
    if (operation.action === 'archive') {
      try {
        await safeDirectory(authority.root, ['.oxy', 'learnings'], false);
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
        return { memoryRevision: 0, records: [], total: 0 };
      }
    }
    if (
      operation.action === 'list' ||
      operation.action === 'get' ||
      operation.action === 'export' ||
      operation.action === 'context' ||
      operation.action === 'inspect'
    ) {
      try {
        await safeDirectory(authority.projectRoot, ['.oxy', 'learnings'], false);
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
        if (operation.action === 'get') throw new Error('NOT_FOUND: learning', { cause: error });
        return { memoryRevision: 0, records: [], total: 0, ...(operation.action === 'export' ? { history: [] } : {}) };
      }
    }
    // One project lock covers the combined budget across all registered checkout stores.
    const directory = await safeDirectory(authority.projectRoot, ['.oxy', 'learnings', 'local']);
    const lease = await acquireLease(directory);
    const checkoutLocks: OwnerLock[] = [];
    try {
      let locations = await memoryLocations(authority);
      const lockRoots = new Set([
        ...authority.checkouts.map((c) => c.root),
        ...(operation.action === 'archive' ? [authority.root] : []),
      ]);
      for (const root of [...lockRoots].sort()) {
        const checkout = { root };
        if (checkout.root === authority.projectRoot) continue;
        const local = await safeDirectory(checkout.root, ['.oxy', 'learnings', 'local']);
        checkoutLocks.push(await acquireLease(local));
      }
      await replayTransaction(authority.projectRoot, [...locations, ...authority.checkouts]);
      locations = await memoryLocations(authority);
      const stores = new Map<MemoryLocation, MemoryFile>();
      for (const checkout of locations) stores.set(checkout, await loadMemory(checkout.root, checkout.archiveId));
      let location = locations.find((c) => c.checkoutId === authority.checkoutId);
      if (operation.action === 'archive') {
        if (!location) throw new Error('UNAVAILABLE: unregistered learning checkout');
        const source = stores.get(location)!;
        const archive = structuredClone(source);
        archive.checkoutId = authority.checkoutId;
        archive.revision++;
        for (const record of archive.records)
          record.applicability[authority.checkoutId] = {
            state: 'archived',
            checkedAt: new Date().toISOString(),
            reason: 'Checkout removed; inspect or explicitly promote to the project',
          };
        await lease.assertOwned();
        const cleared = emptyMemory();
        cleared.revision = archive.revision + 1;
        const sourceLocation = locations.find((c) => !c.archiveId && c.checkoutId === authority.checkoutId) ?? {
          checkoutId: authority.checkoutId,
          root: authority.root,
        };
        const archiveLocation = locations.find((c) => c.archiveId === authority.checkoutId) ?? {
          checkoutId: authority.checkoutId,
          root: authority.projectRoot,
          archiveId: authority.checkoutId,
        };
        stores.set(sourceLocation, cleared);
        stores.set(archiveLocation, archive);
        await commitMemory(authority.projectRoot, stores, new Set([archiveLocation, sourceLocation]));
        this.changed?.(authority.projectId, authority.checkoutId, archive.revision);
        await this.observation.remove(authority.checkoutId);
        return { memoryRevision: archive.revision, records: [], total: archive.records.length };
      }
      const visible = (r: Learning) =>
        r.projectId === authority.projectId && (r.checkoutId === authority.checkoutId || r.scope === 'project');
      const identities = new Map<string, Learning>();
      for (const store of stores.values())
        for (const r of store.records) {
          if (identities.has(r.id)) throw new Error('MEMORY_CORRUPT: duplicate learning identity');
          identities.set(r.id, r);
        }
      for (const r of identities.values()) {
        const seen = new Set([r.id]);
        let next = r.replaces;
        while (next) {
          if (seen.has(next)) throw new Error('MEMORY_CORRUPT: replacement cycle');
          seen.add(next);
          next = identities.get(next)?.replaces;
        }
      }
      if ('id' in operation && operation.id) {
        const owner = [...stores].find(([, store]) => store.records.some((r) => r.id === operation.id && visible(r)));
        if (owner) location = owner[0];
      }
      const file = location && stores.get(location);
      if (!file) throw new Error('UNAVAILABLE: unregistered learning checkout');
      const persist = (target: MemoryLocation, value: MemoryFile) => writeMemory(target.root, value, target.archiveId);
      const allRecords = [...stores.values()].flatMap((f) => f.records).filter(visible);
      if (allRecords.length || operation.action === 'save')
        await this.observation.observe(authority, allRecords, () => {
          void this.run(authority, { action: 'list', search: '', state: 'all', offset: 0 }).catch(() => undefined);
        });
      const snapshot = this.snapshot(authority.archived ? authority.projectId : authority.checkoutId);
      const epoch = this.observation.epoch(authority.checkoutId);
      let refreshed = false;
      for (const [target, store] of stores) {
        let dirty = false;
        for (const record of store.records.filter(visible)) {
          if (record.review !== 'accepted' || authority.archived) continue;
          if (
            this.observation.invalid(authority.checkoutId, record.id) &&
            record.applicability[authority.checkoutId]?.state !== 'needs-review'
          ) {
            record.applicability[authority.checkoutId] = {
              state: 'needs-review',
              checkedAt: new Date().toISOString(),
              reason: 'Evidence watcher observed a change; explicit review is required even after reversion',
            };
            dirty = true;
          }
          dirty = (await checkApplicability(record, authority, snapshot?.graph)) || dirty;
        }
        if (dirty) {
          store.revision++;
          await persist(target, store);
          refreshed = true;
        }
      }
      const result = (records: Learning[], extras: Partial<LearningResult> = {}): LearningResult =>
        LearningResultSchema.parse({
          memoryRevision: [...stores.values()].reduce((n, f) => n + f.revision, 0),
          records,
          total: allRecords.length,
          ...extras,
        });
      if (refreshed) this.changed?.(authority.projectId, authority.checkoutId, result([]).memoryRevision);
      if (operation.action === 'inspect') {
        signal?.throwIfAborted();
        return result(allRecords);
      }
      if (operation.action === 'context') {
        const reviewed = allRecords.filter((r) => r.review === 'accepted');
        const active = reviewed.filter(
          (r) =>
            r.review === 'accepted' &&
            r.admission !== 'automatic' &&
            r.applicability[authority.checkoutId]?.state === 'current',
        );
        const eligible = active.filter(
          (r) =>
            !reviewed.some(
              (other) =>
                other.id !== r.id &&
                (r.conflicts.includes(other.id) ||
                  other.conflicts.includes(r.id) ||
                  (r.topic && normalize(r.topic) === normalize(other.topic ?? '')) ||
                  (r.replaces && r.replaces === other.replaces)),
            ),
        );
        signal?.throwIfAborted();
        return result(eligible);
      }
      if (operation.action === 'list') {
        const search = normalize(operation.search);
        const records = allRecords.filter(
          (record) =>
            (!search || normalize(`${record.title} ${record.body} ${record.topic ?? ''}`).includes(search)) &&
            (operation.state === 'all' ||
              (operation.state === 'needs-review'
                ? record.applicability[authority.checkoutId]?.state === 'needs-review'
                : record.review === operation.state)),
        );
        return result(records.slice(operation.offset, operation.offset + 100), { total: records.length });
      }
      if (operation.action === 'get') {
        const record = file.records.find((r) => r.id === operation.id && visible(r));
        if (!record) throw new Error('NOT_FOUND: learning');
        return result([record], { history: file.history.filter((r) => r.id === record.id) });
      }
      if (operation.action === 'export')
        return result(allRecords, { history: [...stores.values()].flatMap((f) => f.history).filter(visible) });
      const digest = sha256(JSON.stringify(operation));
      const retryKey = sha256(
        `${authority.producer ?? ''}:${authority.origin.source}:${authority.origin.role ?? ''}:${operation.idempotencyKey}`,
      );
      const retry = file.retries.find((r) => r.key === retryKey);
      if (retry) {
        if (retry.digest !== digest) throw new Error('IDEMPOTENCY_CONFLICT: key reused for a different mutation');
        const record = file.records.find((r) => r.id === retry.id);
        return result(record ? [record] : [], { duplicate: true });
      }
      const now = new Date().toISOString();
      const category =
        operation.action === 'feedback'
          ? 'feedback'
          : authority.origin.source === 'agent' && operation.action === 'save'
            ? 'proposal'
            : undefined;
      if (
        category &&
        file.retries.filter((r) => r.kind === category && r.at > Date.now() - 3600000).length >=
          (category === 'proposal' ? 50 : 200)
      )
        throw new Error('RATE_LIMIT: checkout learning limit reached; retry after an hour');
      const old =
        'id' in operation && operation.id ? file.records.find((r) => r.id === operation.id && visible(r)) : undefined;
      if (
        ('id' in operation && operation.id && !old) ||
        (old && old.revision !== operation.expectedRevision) ||
        (operation.action === 'forget' &&
          [...stores.values()].reduce((n, f) => n + f.revision, 0) !== operation.expectedRevision)
      )
        throw new Error('REVISION_CONFLICT: refresh before editing this learning');
      let record: Learning | undefined;
      let duplicateFeedback = false;
      let duplicateProposal = false;
      const dirtyStores = new Set<MemoryLocation>([location!]);
      let promotedTo: MemoryFile | undefined;
      if (operation.action === 'feedback' && old) {
        duplicateFeedback = file.retries.some(
          (r) => r.kind === 'feedback' && r.receiptKey === operation.receiptKey && r.id === old.id,
        );
        record = structuredClone(old);
        if (!duplicateFeedback) {
          if (operation.evidence.length)
            await evidenceFor(authority, { ...old, evidence: operation.evidence }, snapshot?.graph);
          record.feedback[operation.outcome]++;
          if (operation.outcome === 'outdated' || operation.outcome === 'incorrect')
            record.applicability[authority.checkoutId] = {
              state: 'needs-review',
              checkedAt: now,
              reason: `An authenticated client reported ${operation.outcome}; user review is required`,
            };
          file.records = file.records.map((r) => (r.id === record!.id ? record! : r));
        }
      } else if (operation.action === 'save') {
        if (!old && operation.expectedRevision !== 0)
          throw new Error('REVISION_CONFLICT: new learning must start at revision zero');
        if (authority.origin.source === 'agent' && old)
          throw new Error('FORBIDDEN: agents propose replacement records rather than editing reviewed content');
        const evidence = await evidenceFor(authority, operation.draft, snapshot?.graph);
        if (operation.draft.replaces) {
          const seen = new Set(old ? [old.id] : []);
          let id: string | undefined = operation.draft.replaces;
          let first = true;
          while (id) {
            if (seen.has(id)) throw new Error('CONFLICT: replacement cycle or self reference');
            seen.add(id);
            const target = identities.get(id);
            if (!target) throw new Error('CONFLICT: replacement target is unavailable in this checkout');
            if (first && (!visible(target) || !file.records.includes(target)))
              throw new Error('CONFLICT: replace a learning in its original checkout manager');
            first = false;
            id = target.replaces;
          }
        }
        const scope = old?.scope ?? 'checkout';
        const dedup = dedupKey(
          { ...operation.draft, evidence },
          scope,
          scope === 'project' ? authority.projectId : authority.checkoutId,
        );
        const same = allRecords.find(
          (r) => r.id !== old?.id && r.dedup === dedup && r.review !== 'rejected' && r.review !== 'superseded',
        );
        if (same) {
          record = same;
          duplicateProposal = true;
        } else {
          const conflicts = allRecords
            .filter(
              (r) =>
                r.id !== old?.id &&
                r.review !== 'rejected' &&
                r.review !== 'superseded' &&
                ((operation.draft.topic && normalize(operation.draft.topic) === normalize(r.topic ?? '')) ||
                  operation.draft.replaces === r.id),
            )
            .map((r) => r.id);
          record = {
            ...operation.draft,
            id: old?.id ?? randomUUID(),
            revision: (old?.revision ?? 0) + 1,
            dedup,
            evidence,
            projectId: authority.projectId,
            checkoutId: old?.checkoutId ?? authority.checkoutId,
            scope: old?.scope ?? 'checkout',
            createdAt: old?.createdAt ?? now,
            updatedAt: now,
            origin: old?.origin ?? authority.origin,
            editor: authority.origin,
            review: 'proposed',
            admission: 'pending',
            applicability: {},
            conflicts,
            feedback: old?.feedback ?? { used: 0, irrelevant: 0, outdated: 0, incorrect: 0 },
          };
          // Re-read every evidence file and generation immediately before admission.
          if (
            JSON.stringify(await evidenceFor(authority, operation.draft, snapshot?.graph)) !==
              JSON.stringify(evidence) ||
            this.snapshot(authority.checkoutId)?.generation !== snapshot?.generation ||
            this.observation.epoch(authority.checkoutId) !== epoch
          )
            throw new Error('EVIDENCE_CHANGED: retry against the current generation');
          if (old) file.history.push(old);
          file.records = file.records.filter((r) => r.id !== record!.id);
          file.records.push(record);
        }
      } else if (operation.action === 'review' && old) {
        if (authority.origin.source !== 'user')
          throw new Error('FORBIDDEN: only the user may review or promote learnings');
        record = structuredClone(old);
        record.revision++;
        record.updatedAt = now;
        if (operation.decision === 'reject') record.review = 'rejected';
        else {
          if (authority.archived && operation.decision !== 'promote')
            throw new Error('ARCHIVED_CHECKOUT: promote to review against project evidence');
          const evidenceAuthority = authority.archived
            ? { ...authority, root: authority.projectRoot, checkoutId: authority.projectId }
            : authority;
          const evidence = await evidenceFor(evidenceAuthority, old, snapshot?.graph);
          if (
            [...stores.values()]
              .flatMap((s) => s.records)
              .filter((r) => r.scope === 'project' || r.checkoutId === evidenceAuthority.checkoutId)
              .some(
                (r) =>
                  r.id !== record!.id &&
                  r.id !== record!.replaces &&
                  r.review === 'accepted' &&
                  ((record!.topic && normalize(record!.topic) === normalize(r.topic ?? '')) ||
                    (record!.replaces && record!.replaces === r.replaces) ||
                    record!.conflicts.includes(r.id)),
              )
          )
            throw new Error('CONFLICT: reject alternatives or name the reviewed record as a replacement');
          record.evidence = evidence;
          record.review = 'accepted';
          record.admission = 'reviewed';
          record.reviewedAt = now;
          record.reviewer = authority.origin;
          record.applicability = {
            ...old.applicability,
            [evidenceAuthority.checkoutId]: {
              state: 'current',
              checkedAt: now,
              reason: 'User reviewed; matching evidence does not establish truth',
            },
          };
          if (
            JSON.stringify(await evidenceFor(evidenceAuthority, old, snapshot?.graph)) !== JSON.stringify(evidence) ||
            this.snapshot(evidenceAuthority.checkoutId)?.generation !== snapshot?.generation ||
            this.observation.epoch(authority.checkoutId) !== epoch
          )
            throw new Error('EVIDENCE_CHANGED: evidence or generation changed during review');
          if (operation.decision === 'promote') {
            record.scope = 'project';
            record.dedup = dedupKey(record, 'project', authority.projectId);
          }
          if (record.replaces) {
            const replaced = file.records.find((r) => r.id === record!.replaces);
            if (!replaced) throw new Error('CONFLICT: replacement target no longer exists');
            file.history.push(structuredClone(replaced));
            replaced.review = 'superseded';
            replaced.revision++;
            replaced.updatedAt = now;
          }
          record.conflicts = [];
        }
        file.history.push(old);
        file.records = file.records.map((r) => (r.id === record!.id ? record! : r));
        if (operation.decision === 'promote' && location!.checkoutId !== authority.projectId) {
          const projectLocation = locations.find((l) => l.checkoutId === authority.projectId && !l.archiveId);
          if (!projectLocation) throw new Error('UNAVAILABLE: project learning store');
          promotedTo = stores.get(projectLocation)!;
          // Preserve replacement ancestry with the promoted claim, without widening ancestors' checkout scope.
          const moving = new Set([record.id]);
          let ancestor = record.replaces;
          while (ancestor) {
            moving.add(ancestor);
            ancestor = file.records.find((r) => r.id === ancestor)?.replaces;
          }
          promotedTo.records.push(...file.records.filter((r) => moving.has(r.id)));
          promotedTo.history.push(...file.history.filter((r) => moving.has(r.id)));
          file.records = file.records.filter((r) => !moving.has(r.id));
          file.history = file.history.filter((r) => !moving.has(r.id));
          promotedTo.revision++;
          dirtyStores.add(projectLocation);
        }
      } else if (operation.action === 'delete' && old) {
        if (authority.origin.source !== 'user') throw new Error('FORBIDDEN: only users may delete learnings');
        file.records = file.records.filter((r) => r.id !== old.id);
        file.history = file.history.filter((r) => r.id !== old.id);
        for (const r of [...file.records, ...file.history]) {
          r.conflicts = r.conflicts.filter((id) => id !== old.id);
          if (r.replaces === old.id) delete r.replaces;
        }
      } else if (operation.action === 'forget') {
        if (authority.origin.source !== 'user') throw new Error('FORBIDDEN: only users may forget learnings');
        const ids = new Set(allRecords.map((r) => r.id));
        for (const [target, store] of stores) {
          if (!store.records.some((r) => ids.has(r.id)) && !store.history.some((r) => ids.has(r.id))) continue;
          store.records = store.records.filter((r) => !ids.has(r.id));
          store.history = store.history.filter((r) => !ids.has(r.id));
          if (target !== location) store.revision++;
          dirtyStores.add(target);
        }
      }
      file.revision++;
      file.retries = file.retries.filter((r) => r.at > Date.now() - 86400000);
      if (file.retries.length >= 4096) throw new Error('RATE_LIMIT: idempotency budget exhausted');
      file.retries.push({
        key: retryKey,
        digest,
        ...(record ? { id: record.id } : {}),
        revision: file.revision,
        at: Date.now(),
        ...(category ? { kind: category } : {}),
        ...(operation.action === 'feedback' ? { receiptKey: operation.receiptKey } : {}),
      });
      if (promotedTo) promotedTo.retries.push(file.retries.at(-1)!);
      let count = 0,
        bytes = 0;
      for (const store of stores.values()) {
        count += store.records.length;
        bytes += Buffer.byteLength(JSON.stringify(store, null, 2)) + 1;
      }
      if (count > 2000 || bytes > MEMORY_BYTES)
        throw new Error('MEMORY_LIMIT: export and remove learnings before adding more');
      await lease.assertOwned();
      for (const lock of checkoutLocks) await lock.assertOwned();
      signal?.throwIfAborted();
      await commitMemory(authority.projectRoot, stores, dirtyStores);
      this.changed?.(authority.projectId, authority.checkoutId, result([]).memoryRevision);
      if (operation.action === 'review' && operation.decision !== 'reject' && record)
        this.observation.reviewed(authority.checkoutId, record.id);
      await this.observation.observe(authority, [...stores.values()].flatMap((f) => f.records).filter(visible), () => {
        void this.run(authority, { action: 'list', search: '', state: 'all', offset: 0 }).catch(() => undefined);
      });
      return result(record ? [record] : [], duplicateFeedback || duplicateProposal ? { duplicate: true } : {});
    } finally {
      for (const lock of checkoutLocks.reverse()) await lock.dispose();
      await lease.dispose();
    }
  }
}
