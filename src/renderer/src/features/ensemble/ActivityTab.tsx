import { ChevronDown, ChevronRight, Search, StickyNote } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { EnsembleRecord, RunEvent } from '@shared/domain/ensemble';
import { nameOf } from '@shared/ensemble/context';
import { formatDuration } from '@shared/ensemble/flow';
import { cn } from '../../lib/cn';
import { Button } from '../../ui/Button';
import { input } from '../projects/settings/controls';
import { ensembleCommand } from './ensemble-store';
import { askText, Markdown, roleColor, inputSized } from './ui';

const TYPE_GROUPS: { id: string; label: string; types: RunEvent['type'][] }[] = [
  { id: 'all', label: 'Everything', types: [] },
  { id: 'handoffs', label: 'Handoffs', types: ['submitted', 'assigned', 'delivered'] },
  { id: 'talk', label: 'Questions & notes', types: ['question', 'answer', 'note', 'message', 'advice'] },
  { id: 'decisions', label: 'Decisions', types: ['decision', 'gate', 'need', 'reminder'] },
  { id: 'problems', label: 'Problems', types: ['error', 'need'] },
];

/** The whole timeline of the run: handoffs (expandable Markdown), questions, notes, gates, decisions, errors. */
export function ActivityTab({ record }: { record: EnsembleRecord }) {
  const { task, run } = record;
  const [agent, setAgent] = useState('');
  const [group, setGroup] = useState('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const types = useMemo(() => TYPE_GROUPS.find((g) => g.id === group)?.types ?? [], [group]);
  const events = useMemo(
    () =>
      [...run.events]
        .reverse()
        .filter(
          (e) =>
            e.type !== 'state' &&
            e.type !== 'context' &&
            (!agent || e.agentId === agent) &&
            (types.length === 0 || types.includes(e.type)) &&
            (!query || `${e.text} ${e.inputs ?? ''} ${e.outcome ?? ''}`.toLowerCase().includes(query.toLowerCase())),
        ),
    [run.events, agent, types, query],
  );
  const start = run.startedAt ?? 0;
  const handoff = (id: string | undefined) => (id ? run.handoffs.find((h) => h.id === id) : undefined);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="ensemble-activity">
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-line-subtle px-4 py-2">
        <select
          aria-label="Agent"
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
          className={cn(inputSized, 'w-40')}
        >
          <option value="">All agents</option>
          {task.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Kind"
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          className={cn(inputSized, 'w-44')}
        >
          {TYPE_GROUPS.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label}
            </option>
          ))}
        </select>
        <label className="relative flex min-w-40 flex-1 items-center">
          <Search size={12} className="absolute left-2 text-fg-muted" />
          <input
            aria-label="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className={cn(input, 'pl-6')}
          />
        </label>
        <Button
          size="sm"
          onClick={() =>
            void askText({
              title: 'Note for the team',
              description: 'Every agent sees the notes board in oxy_ensemble_context.',
              placeholder: 'A decision, a gotcha…',
              confirmLabel: 'Post',
            }).then((text) => !!text && ensembleCommand(task.id, { type: 'note', by: 'user', text }))
          }
        >
          <StickyNote size={12} /> Post note
        </Button>
      </div>
      <ol className="min-h-0 flex-1 overflow-auto px-4 py-2">
        {run.eventCount > run.events.length && (
          <li className="pb-2 text-small text-fg-muted">
            The {run.eventCount - run.events.length} oldest events are in the task&apos;s events.jsonl.
          </li>
        )}
        {events.length === 0 && <li className="text-small text-fg-muted">Nothing yet.</li>}
        {events.map((e) => {
          const h = handoff(e.handoffId);
          const expanded = open.has(String(e.id));
          const who = e.agentId ? task.agents.find((a) => a.id === e.agentId) : undefined;
          return (
            <li
              key={e.id}
              className="flex gap-3 border-b border-line-subtle py-1.5"
              data-testid="ensemble-activity-item"
              data-type={e.type}
            >
              <span className="w-12 flex-none pt-px font-mono text-[11px] text-fg-muted">
                {start ? formatDuration(e.at - start) : ''}
              </span>
              <span
                className="w-20 flex-none truncate pt-px text-small font-medium"
                style={{ color: who ? roleColor(who.role.color) : undefined }}
              >
                {who ? who.name : e.by === 'you' ? 'you' : 'conductor'}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <button
                  type="button"
                  disabled={!h}
                  onClick={() =>
                    setOpen((s) => {
                      const next = new Set(s);
                      if (next.has(String(e.id))) next.delete(String(e.id));
                      else next.add(String(e.id));
                      return next;
                    })
                  }
                  className={cn('flex items-start gap-1 text-left', h ? 'cursor-pointer' : 'cursor-default')}
                >
                  {h &&
                    (expanded ? (
                      <ChevronDown size={12} className="mt-0.5" />
                    ) : (
                      <ChevronRight size={12} className="mt-0.5" />
                    ))}
                  <span
                    className={cn(
                      'min-w-0 flex-1',
                      e.type === 'error' ? 'text-danger' : e.type === 'need' ? 'text-warning' : 'text-fg',
                    )}
                  >
                    {e.type === 'decision' ? (
                      <>
                        <span className="text-fg-secondary">{e.text}:</span> {e.inputs}{' '}
                        <span className="text-fg">{e.outcome}</span>
                        <span className="ml-1 font-mono text-[10px] text-fg-muted">({e.by ?? 'rule'})</span>
                      </>
                    ) : (
                      e.text
                    )}
                  </span>
                </button>
                {h && expanded && (
                  <div className="rounded-control border border-line-subtle bg-card p-3">
                    {h.findings && h.findings.length > 0 && (
                      <ul className="mb-2 flex flex-col gap-0.5 text-small">
                        {h.findings.map((f, i) => (
                          <li key={i}>
                            <span className="font-mono text-fg-secondary">[{f.severity}]</span>{' '}
                            {f.file && (
                              <span className="font-mono text-fg-secondary">
                                {f.file}
                                {f.line ? `:${f.line}` : ''}
                              </span>
                            )}{' '}
                            {f.message}
                          </li>
                        ))}
                      </ul>
                    )}
                    <Markdown text={h.body?.trim() ? h.body : h.summary} />
                    <div className="mt-2 text-[10px] text-fg-muted">by {nameOf(task, h.agentId)}</div>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
