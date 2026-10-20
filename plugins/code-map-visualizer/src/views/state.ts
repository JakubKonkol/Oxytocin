/** Late responses must match both the request sequence and project identity. */
export class ViewEpoch {
  private sequence = 0;
  private project = '';
  begin(project: string): number {
    this.project = project;
    return ++this.sequence;
  }
  accepts(sequence: number, project: string): boolean {
    return sequence === this.sequence && project === this.project;
  }
  invalidate(): void {
    this.sequence++;
  }
}
export function stablePositions(ids: readonly string[], previous: ReadonlyMap<string, { x: number; y: number }>) {
  const next = new Map<string, { x: number; y: number }>();
  const used = new Set([...previous.values()].map((p) => `${p.x}:${p.y}`));
  let slot = 0;
  for (const id of ids) {
    const known = previous.get(id);
    if (known) {
      next.set(id, known);
      continue;
    }
    let p: { x: number; y: number };
    do {
      p = { x: (slot % 12) * 160, y: Math.floor(slot / 12) * 100 };
      slot++;
    } while (used.has(`${p.x}:${p.y}`));
    next.set(id, p);
    used.add(`${p.x}:${p.y}`);
  }
  return next;
}
