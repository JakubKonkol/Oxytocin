import { randomUUID } from 'node:crypto';
import type { LearningActor, TaskContextResult } from '@shared/domain/code-map-learning-tools';
import { sha256 } from '../store/writer';

export const actorKey = (actor: LearningActor): string =>
  sha256(JSON.stringify([actor.principal, actor.session, actor.role, actor.task ?? '']));
export interface ContextReceipt {
  id: string;
  projectId: string;
  checkoutId: string;
  generation: number;
  memoryRevision: number;
  actor: string;
  principal: string;
  expiresAt: number;
  nodes: { id: string; whyIncluded: string }[];
  relations: TaskContextResult['relations'];
  learnings: { id: string; revision: number; whyIncluded: string }[];
}
/** Bounded ephemeral selections. Never stores the question, transcript, source text or client bearer token. */
export class ContextReceipts {
  private readonly receipts = new Map<string, ContextReceipt>();
  private bytes = 0;
  constructor(private readonly now = Date.now) {}
  private drop(id: string): void {
    const r = this.receipts.get(id);
    if (r) this.bytes -= Buffer.byteLength(JSON.stringify(r));
    this.receipts.delete(id);
  }
  prune(): void {
    for (const [id, r] of this.receipts) if (r.expiresAt <= this.now()) this.drop(id);
  }
  create(projectId: string, actor: LearningActor, result: TaskContextResult, id = randomUUID()): string {
    this.prune();
    const receipt: ContextReceipt = {
      id,
      projectId,
      checkoutId: result.checkoutId,
      generation: result.generation,
      memoryRevision: result.memoryRevision,
      actor: actorKey(actor),
      principal: actor.principal,
      expiresAt: this.now() + 30 * 60000,
      nodes: result.nodes.map(({ id, whyIncluded }) => ({ id, whyIncluded })),
      relations: structuredClone(result.relations),
      learnings: result.learnings.map(({ id, revision, whyIncluded }) => ({ id, revision, whyIncluded })),
    };
    const bytes = Buffer.byteLength(JSON.stringify(receipt));
    if (bytes > 4 * 1024 * 1024) throw new Error('RATE_LIMIT: context receipt too large');
    while (this.receipts.size >= 256 || this.bytes + bytes > 4 * 1024 * 1024)
      this.drop(this.receipts.keys().next().value!);
    this.receipts.set(id, receipt);
    this.bytes += bytes;
    return id;
  }
  inspect(id: string, projectId: string, checkoutId: string): ContextReceipt {
    this.prune();
    const receipt = this.receipts.get(id);
    if (!receipt) throw new Error('RECEIPT_EXPIRED: unknown or expired context receipt');
    if (receipt.projectId !== projectId || receipt.checkoutId !== checkoutId)
      throw new Error('INVALID_RECEIPT: wrong checkout');
    return structuredClone(receipt);
  }
  feedback(
    id: string,
    projectId: string,
    checkoutId: string,
    actor: LearningActor,
    learningId: string,
    revision: number,
  ): ContextReceipt {
    const receipt = this.inspect(id, projectId, checkoutId);
    if (
      receipt.actor !== actorKey(actor) ||
      !receipt.learnings.some((l) => l.id === learningId && l.revision === revision)
    )
      throw new Error('INVALID_RECEIPT: feedback must name an item emitted to this authenticated session');
    return receipt;
  }
  revoke(projectId: string, checkoutId?: string): void {
    for (const [id, r] of this.receipts)
      if (r.projectId === projectId && (!checkoutId || r.checkoutId === checkoutId)) this.drop(id);
  }
  revokeActor(principal: string): void {
    for (const [id, r] of this.receipts) if (r.principal === principal) this.drop(id);
  }
}
