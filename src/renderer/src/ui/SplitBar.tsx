import { cn } from '../lib/cn';

/** Proportion of added vs deleted lines (CHANGES header). */
export function SplitBar({ added, deleted, className }: { added: number; deleted: number; className?: string }) {
  const total = added + deleted;
  const addedPct = total === 0 ? 0 : (added / total) * 100;
  return (
    <div
      role="img"
      aria-label={`${added} lines added, ${deleted} lines deleted`}
      className={cn('flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full', total === 0 && 'bg-input', className)}
    >
      {total > 0 && (
        <>
          <div data-part="added" className="h-full rounded-full bg-git-added" style={{ width: `${addedPct}%` }} />
          <div data-part="deleted" className="h-full flex-1 rounded-full bg-git-deleted" />
        </>
      )}
    </div>
  );
}
