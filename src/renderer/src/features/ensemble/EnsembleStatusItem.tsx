import { Workflow } from 'lucide-react';
import { useMemo } from 'react';
import { isActiveStatus } from '@shared/domain/ensemble';
import { useEnsembleStore } from './ensemble-store';
import { showEnsemble } from './ensemble-actions';

/** Items waiting for the user in active Ensemble tasks (agents waiting in their terminal count elsewhere). */
export function ensembleNeedsCount(records: ReturnType<typeof useEnsembleStore.getState>['records']): number {
  let n = 0;
  for (const r of Object.values(records))
    if (isActiveStatus(r.run.status))
      n += r.run.needs.filter((x) => x.kind !== 'permission' && x.kind !== 'finish').length;
  return n;
}

export const useEnsembleNeedsCount = () => useEnsembleStore((s) => ensembleNeedsCount(s.records));

/** The first task that needs the user (Ctrl+Shift+J after waiting agents). */
export function firstEnsembleNeed(): { projectId: string; taskId: string } | null {
  for (const r of Object.values(useEnsembleStore.getState().records))
    if (isActiveStatus(r.run.status) && r.run.needs.some((x) => x.kind !== 'permission' && x.kind !== 'finish'))
      return { projectId: r.task.projectId, taskId: r.task.id };
  return null;
}

/** Status bar: "Ensemble 1 running · 1 needs you" while tasks run; opens the panel. */
export function EnsembleStatusItem() {
  const records = useEnsembleStore((s) => s.records);
  const { running, needs, target } = useMemo(() => {
    let running = 0;
    let needs = 0;
    let target: { projectId: string; taskId: string } | null = null;
    for (const r of Object.values(records)) {
      if (!isActiveStatus(r.run.status)) continue;
      running++;
      const n = r.run.needs.filter((x) => x.kind !== 'finish').length;
      needs += n;
      if (n > 0 && !target) target = { projectId: r.task.projectId, taskId: r.task.id };
      target ??= { projectId: r.task.projectId, taskId: r.task.id };
    }
    return { running, needs, target };
  }, [records]);
  if (running === 0) return null;
  return (
    <button
      type="button"
      data-testid="status-ensemble"
      className="flex items-center gap-1 hover:text-fg"
      title="Open Ensemble"
      onClick={() => void showEnsemble(target?.projectId, target?.taskId)}
    >
      <Workflow size={12} className="text-agent" />
      <span>Ensemble {running} running</span>
      {needs > 0 && (
        <span className="text-warning">
          · {needs} need{needs === 1 ? 's' : ''} you
        </span>
      )}
    </button>
  );
}
