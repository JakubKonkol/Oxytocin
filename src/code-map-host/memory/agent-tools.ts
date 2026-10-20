import { randomUUID } from 'node:crypto';
import type { MemoryAuthority } from '@shared/domain/code-map-memory';
import {
  LearningActorSchema,
  LearningToolErrorSchema,
  LearningToolRequestSchema,
  LearningToolResultSchema,
  type LearningActor,
  type LearningToolRequest,
  type LearningToolResult,
} from '@shared/domain/code-map-learning-tools';
import type { CodeMapCheckouts } from '../checkouts';
import type { LearningMemory } from './admission';
import { actorKey, ContextReceipts } from './receipts';
import { taskContext } from './context';
import { sha256 } from '../store/writer';
import {
  CodeMapSliceQuerySchema,
  type CodeMapSliceQuery,
  type CodeMapHostQueryResult,
} from '@shared/domain/code-map-plugin';
import { boundSliceResult } from '../query/slice-budget';
import { knowledgeSlice } from './knowledge';

const errors: Record<string, string> = {
  UNAVAILABLE: 'Code Map or checkout access is unavailable.',
  MEMORY_OFF: 'Enable Review mode in Project settings to propose findings or send feedback.',
  MEMORY_UNAVAILABLE: 'Memory is unavailable; inspect the core Learnings manager.',
  BUDGET_TOO_SMALL: 'Raise maxChars to fit required metadata and complete items.',
  RATE_LIMIT: 'Learning or receipt budget reached; retry later.',
  EVIDENCE_CHANGED: 'Evidence or the indexed generation changed; read current source and retry.',
  INVALID_EVIDENCE:
    'Use permitted project-relative indexed sources or bounded documents, with valid symbol identities and spans.',
  REVISION_CONFLICT: 'The learning revision changed; refresh context before retrying.',
  IDEMPOTENCY_CONFLICT: 'Use a fresh key for a different mutation.',
  CONFLICT: 'An alternative or replacement needs user review in the Learnings manager.',
  MEMORY_LIMIT: 'Export and prune findings or revision history in the Learnings manager.',
  RECEIPT_EXPIRED: 'The receipt expired or is unavailable; request task context again.',
  INVALID_RECEIPT: 'Feedback must name a learning emitted to this session and checkout.',
  SNAPSHOT_CHANGED: 'The code or memory snapshot changed; request current task context.',
  CANCELLED: 'Request cancelled or access revoked.',
};
export function learningFailure(error: unknown): LearningToolResult {
  const prefix =
    error instanceof Error && error.name === 'AbortError'
      ? 'CANCELLED'
      : String(error instanceof Error ? error.message : error).split(':')[0]!;
  const code = LearningToolErrorSchema.shape.code.safeParse(prefix);
  const safe = code.success ? code.data : 'MEMORY_UNAVAILABLE';
  return { kind: 'error', code: safe, message: errors[safe]! };
}
/** MCP operations retain server-supplied checkout/session identity through the entire host boundary. */
export class LearningTools {
  readonly receipts = new ContextReceipts();
  private readonly running = new Map<
    string,
    { authority: MemoryAuthority; principal: string; controller: AbortController }
  >();
  constructor(
    private readonly checkouts: Pick<CodeMapCheckouts, 'query' | 'memorySnapshot' | 'cancelQuery'>,
    readonly memory: LearningMemory,
  ) {}
  cancel(id: string): void {
    this.running.get(id)?.controller.abort();
    this.checkouts.cancelQuery(`${id}:structure`);
  }
  revoke(projectId: string, checkoutId?: string): void {
    this.receipts.revoke(projectId, checkoutId);
    for (const [id, r] of this.running)
      if (r.authority.projectId === projectId && (!checkoutId || r.authority.checkoutId === checkoutId))
        this.cancel(id);
  }
  revokeActor(principal: string): void {
    this.receipts.revokeActor(principal);
    for (const [id, r] of this.running) if (r.principal === principal) this.cancel(id);
  }
  async view(
    requestId: string,
    authority: MemoryAuthority,
    input: CodeMapSliceQuery,
    mode: 'off' | 'review',
  ): Promise<CodeMapHostQueryResult> {
    const query = CodeMapSliceQuerySchema.parse(input);
    if (query.view !== 'knowledge' && query.view !== 'context-receipt') throw new Error('Not a knowledge view');
    if (this.running.has(requestId) || this.running.size >= 100) throw new Error('Too many knowledge views');
    const controller = new AbortController();
    this.running.set(requestId, { authority, principal: 'user-view', controller });
    try {
      const structure = await this.checkouts.query(authority.checkoutId, `${requestId}:structure`, {
        kind: 'status',
        freshness: query.freshness,
        maxChars: 24000,
      });
      controller.signal.throwIfAborted();
      const result: CodeMapHostQueryResult = {
        ...structure,
        data: undefined,
        hint: 'Reference findings and their recorded evidence. Matching hashes do not establish semantic truth.',
      };
      if (mode === 'off')
        return {
          ...result,
          code: query.view === 'context-receipt' ? 'RECEIPT_EXPIRED' : 'MEMORY_OFF',
          hint: 'Memory is off; existing findings remain in the core Learnings manager.',
        };
      try {
        const receipt =
          query.view === 'context-receipt'
            ? this.receipts.inspect(query.receipt!, authority.projectId, authority.checkoutId)
            : undefined;
        const snapshot = this.checkouts.memorySnapshot(authority.checkoutId);
        const epoch = this.memory.observation.epoch(authority.checkoutId);
        const memory = await this.memory.inspect(authority, controller.signal);
        controller.signal.throwIfAborted();
        if (receipt) this.receipts.inspect(receipt.id, authority.projectId, authority.checkoutId);
        if (
          snapshot?.generation !== this.checkouts.memorySnapshot(authority.checkoutId)?.generation ||
          epoch !== this.memory.observation.epoch(authority.checkoutId) ||
          (snapshot && snapshot.generation !== structure.freshness.generation) ||
          (query.generation !== undefined && query.generation !== snapshot?.generation) ||
          (receipt &&
            (receipt.generation !== snapshot?.generation ||
              receipt.memoryRevision !== memory.memoryRevision ||
              !receipt.learnings.every((l) =>
                memory.records.some(
                  (r) =>
                    r.id === l.id &&
                    r.revision === l.revision &&
                    r.review === 'accepted' &&
                    r.admission !== 'automatic' &&
                    r.applicability[authority.checkoutId]?.state === 'current' &&
                    !r.conflicts.length,
                ),
              )))
        )
          return {
            ...result,
            code: 'SNAPSHOT_CHANGED',
            hint: 'The named code generation or memory revision is unavailable. Request new task context.',
          };
        const projected = knowledgeSlice(
          snapshot?.graph,
          memory.records,
          authority.checkoutId,
          query,
          memory.memoryRevision,
          receipt,
        );
        result.data = projected.data;
        result.reasons = projected.reasons;
        result.truncated = projected.reasons.length > 0;
        return boundSliceResult(result);
      } catch (error) {
        const failure = learningFailure(error);
        return {
          ...result,
          code:
            failure.code === 'RECEIPT_EXPIRED' || failure.code === 'INVALID_RECEIPT'
              ? 'RECEIPT_EXPIRED'
              : 'MEMORY_UNAVAILABLE',
          hint: failure.kind === 'error' ? failure.message : 'Memory is unavailable.',
        };
      }
    } finally {
      this.running.delete(requestId);
    }
  }
  async run(
    requestId: string,
    authority: MemoryAuthority,
    actorInput: LearningActor,
    input: LearningToolRequest,
    mode: 'off' | 'review',
  ): Promise<LearningToolResult> {
    const actor = LearningActorSchema.parse(actorInput),
      request = LearningToolRequestSchema.parse(input);
    if (this.running.has(requestId) || this.running.size >= 100) return learningFailure(new Error('RATE_LIMIT'));
    const controller = new AbortController(),
      signal = controller.signal;
    this.running.set(requestId, { authority, principal: actor.principal, controller });
    const authenticated = {
      ...authority,
      producer: actorKey(actor),
      origin: { source: 'agent' as const, role: actor.role, ...(actor.task ? { task: actor.task } : {}) },
    };
    try {
      if (request.kind === 'task-context') {
        const structure = await this.checkouts.query(authority.checkoutId, `${requestId}:structure`, {
          kind: 'status',
          freshness: request.freshness,
          maxChars: 24000,
        });
        signal.throwIfAborted();
        const snapshot = this.checkouts.memorySnapshot(authority.checkoutId);
        let memory = { memoryRevision: 0, records: [], total: 0 } as Awaited<ReturnType<LearningMemory['context']>>;
        let state: 'ready' | 'off' | 'unavailable' = mode === 'off' ? 'off' : 'ready';
        const epoch = this.memory.observation.epoch(authority.checkoutId);
        if (mode !== 'off') {
          try {
            memory = await this.memory.context(authenticated, signal);
          } catch {
            signal.throwIfAborted();
            state = 'unavailable';
          }
          if (this.memory.observation.epoch(authority.checkoutId) !== epoch) {
            memory.records = [];
            state = 'unavailable';
          }
        }
        signal.throwIfAborted();
        if (
          snapshot?.generation !== this.checkouts.memorySnapshot(authority.checkoutId)?.generation ||
          (snapshot && snapshot.generation !== structure.freshness.generation)
        )
          throw new Error('SNAPSHOT_CHANGED');
        const receipt = mode !== 'off' && state === 'ready' ? randomUUID() : undefined;
        const result = taskContext(
          request,
          snapshot?.graph,
          structure.freshness,
          memory,
          state,
          authority.checkoutId,
          receipt,
        );
        if (receipt) this.receipts.create(authority.projectId, actor, result, receipt);
        return result;
      }
      if (mode === 'off') throw new Error('MEMORY_OFF');
      let result;
      if (request.kind === 'propose')
        result = await this.memory.run(
          authenticated,
          {
            action: 'save',
            draft: request.draft,
            expectedRevision: request.expectedRevision,
            idempotencyKey: request.idempotencyKey,
          },
          signal,
        );
      else {
        this.receipts.feedback(
          request.receipt,
          authority.projectId,
          authority.checkoutId,
          actor,
          request.id,
          request.revision,
        );
        const { receipt, revision, kind: _kind, ...feedback } = request;
        result = await this.memory.feedback(
          authenticated,
          {
            ...feedback,
            action: 'feedback',
            expectedRevision: revision,
            receiptKey: sha256(JSON.stringify([actorKey(actor), receipt, request.id, revision, request.outcome])),
          },
          signal,
        );
      }
      signal.throwIfAborted();
      const record = result.records[0];
      if (!record) throw new Error('REVISION_CONFLICT');
      return LearningToolResultSchema.parse({
        kind: request.kind,
        code: 'OK',
        id: record.id,
        revision: record.revision,
        memoryRevision: result.memoryRevision,
        review: record.review,
        applicability: record.applicability[authority.checkoutId]?.state ?? 'pending',
        duplicate: result.duplicate ?? false,
      });
    } catch (error) {
      return learningFailure(error);
    } finally {
      this.running.delete(requestId);
    }
  }
}
