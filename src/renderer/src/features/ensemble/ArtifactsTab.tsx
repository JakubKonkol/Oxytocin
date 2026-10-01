import { Copy, FileText } from 'lucide-react';
import { useState } from 'react';
import { type EnsembleRecord, type Handoff, OUTPUT_LABELS } from '@shared/domain/ensemble';
import { nameOf } from '@shared/ensemble/context';
import { cn } from '../../lib/cn';
import { ipc } from '../../lib/ipc-client';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { notify } from '../../ui/Toast';
import { Markdown } from './ui';

const title = (record: EnsembleRecord, h: Handoff) =>
  h.agentId === 'conductor'
    ? h.summary
    : `${OUTPUT_LABELS[h.kind]} · ${nameOf(record.task, h.agentId)}${h.round ? ` · round ${h.round}` : ''}`;

/** What the agents produced: plans, reviews, test reports, the report of the run. */
export function ArtifactsTab({ record }: { record: EnsembleRecord }) {
  const items = [...record.run.handoffs].reverse();
  const [selected, setSelected] = useState<string>(items[0]?.id ?? 'report');
  const [report, setReport] = useState<string | null>(null);
  const current = items.find((h) => h.id === selected);
  const showReport = () => {
    setSelected('report');
    void ipc.invoke('ensemble:report', { taskId: record.task.id }).then((r) => setReport(r.text));
  };
  const text =
    selected === 'report' ? (report ?? '') : current ? (current.body?.trim() ? current.body : current.summary) : '';
  if (items.length === 0 && record.run.status === 'draft')
    return (
      <EmptyState
        className="h-full"
        title="No artifacts yet"
        description="Plans, reviews and test reports appear here."
      />
    );
  return (
    <div className="flex h-full min-h-0" data-testid="ensemble-artifacts">
      <div
        role="listbox"
        aria-label="Artifacts"
        className="flex w-64 flex-none flex-col gap-0.5 overflow-auto border-r border-line-subtle p-2"
      >
        <button
          type="button"
          role="option"
          aria-selected={selected === 'report'}
          onClick={showReport}
          className={cn(
            'flex items-center gap-1.5 rounded-control px-2 py-1 text-left',
            selected === 'report' ? 'bg-focus-tint' : 'hover:bg-card-hover',
          )}
        >
          <FileText size={13} className="text-accent" /> Report (Markdown)
        </button>
        {items.map((h) => (
          <button
            key={h.id}
            type="button"
            role="option"
            aria-selected={selected === h.id}
            data-testid="ensemble-artifact"
            onClick={() => setSelected(h.id)}
            className={cn(
              'flex flex-col rounded-control px-2 py-1 text-left',
              selected === h.id ? 'bg-focus-tint' : 'hover:bg-card-hover',
            )}
          >
            <span className="truncate text-ui text-fg">{title(record, h)}</span>
            <span className="truncate text-small text-fg-muted">{h.summary}</span>
          </button>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-none items-center gap-2 border-b border-line-subtle px-4 py-2">
          <span className="min-w-0 flex-1 truncate font-medium text-fg">
            {selected === 'report' ? 'Report' : current ? title(record, current) : ''}
          </span>
          <Button
            size="sm"
            disabled={!text}
            onClick={() =>
              void ipc.invoke('clipboard:writeText', { text }).then(() => notify('success', 'Copied to the clipboard'))
            }
          >
            <Copy size={12} /> Copy
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {selected === 'report' && report === null ? (
            <Button size="sm" onClick={showReport}>
              Build the report
            </Button>
          ) : (
            <Markdown text={text} />
          )}
        </div>
      </div>
    </div>
  );
}
