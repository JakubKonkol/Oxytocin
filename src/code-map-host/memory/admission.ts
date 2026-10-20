import { randomUUID } from 'node:crypto';
import type { CodeMapGraph } from '@shared/domain/code-map';
import type { Learning, LearningOperation, LearningResult, MemoryAuthority } from '@shared/domain/code-map-memory';
import { LearningOperationSchema, LearningResultSchema, MemoryAuthoritySchema } from '@shared/domain/code-map-memory';
import { OwnerLock } from '../store/owner-lock';
import { hasCode, safeDirectory } from '../store/paths';
import { sha256 } from '../store/writer';
import { checkApplicability, evidenceFor } from './applicability';
import { loadMemory, MEMORY_BYTES, writeMemory, type MemoryFile } from './store';

const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
export class LearningMemory {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly snapshot: (checkoutId: string) => { graph: CodeMapGraph; generation: number } | undefined,
  ) {}

  run(authority: MemoryAuthority, operation: LearningOperation): Promise<LearningResult> {
    const next = this.queue.then(() =>
      this.execute(MemoryAuthoritySchema.parse(authority), LearningOperationSchema.parse(operation)),
    );
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async execute(authority: MemoryAuthority, operation: LearningOperation): Promise<LearningResult> {
    if (operation.action === 'list' || operation.action === 'get' || operation.action === 'export') {
      try {
        await safeDirectory(authority.root, ['.oxy', 'learnings'], false);
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
        if (operation.action === 'get') throw new Error('NOT_FOUND: learning', { cause: error });
        return { memoryRevision: 0, records: [], total: 0, ...(operation.action === 'export' ? { history: [] } : {}) };
      }
    }
    // One project lock covers the combined budget across all registered checkout stores.
    const directory = await safeDirectory(authority.projectRoot, ['.oxy', 'learnings', 'local']);
    const { lease } = await OwnerLock.acquire(directory, 'Oxytocin Learnings');
    if (!lease) throw new Error('MEMORY_BUSY: updated by another Oxytocin instance');
    const checkoutLocks: OwnerLock[] = [];
    try {
      for (const checkout of authority.checkouts.filter((c) => c.root === authority.root)) {
        if (checkout.root === authority.projectRoot) continue;
        const local = await safeDirectory(checkout.root, ['.oxy', 'learnings', 'local']);
        const claim = await OwnerLock.acquire(local, 'Oxytocin Learnings');
        if (!claim.lease) throw new Error('MEMORY_BUSY: checkout updated by another instance');
        checkoutLocks.push(claim.lease);
      }
      const stores = new Map<string, MemoryFile>();
      for (const checkout of authority.checkouts) stores.set(checkout.root, await loadMemory(checkout.root));
      const file = stores.get(authority.root);
      if (!file) throw new Error('UNAVAILABLE: unregistered learning checkout');
      const snapshot = this.snapshot(authority.checkoutId);
      let dirty = false;
      for (const record of file.records)
        if (record.review === 'accepted')
          dirty = (await checkApplicability(record, authority, snapshot?.graph)) || dirty;
      if (dirty) {
        file.revision++;
        await writeMemory(authority.root, file);
      }
      const result = (records: Learning[], extras: Partial<LearningResult> = {}): LearningResult =>
        LearningResultSchema.parse({ memoryRevision: file.revision, records, total: file.records.length, ...extras });
      if (operation.action === 'list') {
        const search = normalize(operation.search);
        const records = file.records.filter(
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
        const record = file.records.find((r) => r.id === operation.id);
        if (!record) throw new Error('NOT_FOUND: learning');
        return result([record], { history: file.history.filter((r) => r.id === record.id) });
      }
      if (operation.action === 'export') return result(file.records, { history: file.history });
      const digest = sha256(JSON.stringify(operation));
      const retryKey = sha256(`${authority.origin.source}:${authority.origin.role ?? ''}:${operation.idempotencyKey}`);
      const retry = file.retries.find((r) => r.key === retryKey);
      if (retry) {
        if (retry.digest !== digest) throw new Error('IDEMPOTENCY_CONFLICT: key reused for a different mutation');
        const record = file.records.find((r) => r.id === retry.id);
        return result(record ? [record] : [], { duplicate: true });
      }
      const now = new Date().toISOString();
      const old = 'id' in operation && operation.id ? file.records.find((r) => r.id === operation.id) : undefined;
      if (
        ('id' in operation && operation.id && !old) ||
        (old && old.revision !== operation.expectedRevision) ||
        (operation.action === 'forget' && file.revision !== operation.expectedRevision)
      )
        throw new Error('REVISION_CONFLICT: refresh before editing this learning');
      let record: Learning | undefined;
      if (operation.action === 'save') {
        if (!old && operation.expectedRevision !== 0)
          throw new Error('REVISION_CONFLICT: new learning must start at revision zero');
        if (authority.origin.source === 'agent' && old)
          throw new Error('FORBIDDEN: agents propose replacement records rather than editing reviewed content');
        const evidence = await evidenceFor(authority, operation.draft, snapshot?.graph);
        const dedup = sha256(
          JSON.stringify([
            authority.checkoutId,
            operation.draft.kind,
            normalize(operation.draft.title),
            normalize(operation.draft.body),
            evidence.map((e) => [e.path, e.symbolId ?? '']).sort(),
          ]),
        );
        const same = file.records.find(
          (r) => r.id !== old?.id && r.dedup === dedup && r.review !== 'rejected' && r.review !== 'superseded',
        );
        if (same) record = same;
        else {
          const conflicts = file.records
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
            checkoutId: authority.checkoutId,
            scope: old?.scope ?? 'checkout',
            createdAt: old?.createdAt ?? now,
            updatedAt: now,
            origin: old?.origin ?? authority.origin,
            review: 'proposed',
            applicability: {},
            conflicts,
            feedback: old?.feedback ?? { used: 0, irrelevant: 0, outdated: 0, incorrect: 0 },
          };
          // Re-read every evidence file and generation immediately before admission.
          if (
            JSON.stringify(await evidenceFor(authority, operation.draft, snapshot?.graph)) !==
              JSON.stringify(evidence) ||
            this.snapshot(authority.checkoutId)?.generation !== snapshot?.generation
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
          const evidence = await evidenceFor(authority, old, snapshot?.graph);
          if (
            record.conflicts.some(
              (id) => id !== record!.replaces && file.records.some((r) => r.id === id && r.review === 'accepted'),
            )
          )
            throw new Error('CONFLICT: reject alternatives or name the reviewed record as a replacement');
          record.evidence = evidence;
          record.review = 'accepted';
          record.reviewedAt = now;
          record.applicability = {
            [authority.checkoutId]: {
              state: 'current',
              checkedAt: now,
              reason: 'User reviewed; matching evidence does not establish truth',
            },
          };
          if (operation.decision === 'promote') record.scope = 'project';
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
        file.records = [];
        file.history = [];
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
      });
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
      await writeMemory(authority.root, file);
      return result(record ? [record] : []);
    } finally {
      for (const lock of checkoutLocks.reverse()) await lock.dispose();
      await lease.dispose();
    }
  }
}
