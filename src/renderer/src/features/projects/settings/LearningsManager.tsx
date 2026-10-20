import { useEffect, useState } from 'react';
import type { Learning, LearningDraft, LearningOperation, LearningResult } from '@shared/domain/code-map-memory';
import { LearningDraftSchema } from '@shared/domain/code-map-memory';
import { ipc } from '../../../lib/ipc-client';
import { confirmDialog } from '../../../stores/dialog-store';
import { Button } from '../../../ui/Button';
import { Field, Section, input } from './controls';

const blank: LearningDraft = { kind: 'constraint', title: '', body: '', rationale: '', evidence: [] };
export function LearningsManager({ projectId }: { projectId: string }) {
  const [result, setResult] = useState<LearningResult | null>(null);
  const [selected, setSelected] = useState<Learning | null>(null);
  const [history, setHistory] = useState<Learning[]>([]);
  const [draft, setDraft] = useState<LearningDraft>(blank);
  const [paths, setPaths] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'proposed' | 'accepted' | 'needs-review' | 'rejected' | 'superseded'>(
    'all',
  );
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = (operation: LearningOperation) => ipc.invoke('codeMap:memory', { projectId, operation });
  useEffect(() => {
    let cancelled = false;
    void ipc
      .invoke('codeMap:memory', { projectId, operation: { action: 'list', search, state: filter, offset } })
      .then((value) => {
        if (!cancelled) setResult(value);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, search, filter, offset]);
  const choose = (record: Learning | null) => {
    setSelected(record);
    setHistory([]);
    setDraft(
      record
        ? {
            kind: record.kind,
            title: record.title,
            body: record.body,
            rationale: record.rationale,
            topic: record.topic,
            evidence: record.evidence.map(({ path, symbolId, span }) => ({ path, symbolId, span })),
            replaces: record.replaces,
          }
        : blank,
    );
    setPaths(record?.evidence.map((e) => e.path).join('\n') ?? '');
  };
  const run = async (operation: LearningOperation) => {
    setBusy(true);
    setError('');
    try {
      const response = await request(operation);
      if (operation.action === 'get') {
        choose(response.records[0] ?? null);
        setHistory(response.history ?? []);
      } else if (operation.action === 'export') {
        const url = URL.createObjectURL(
          new Blob(
            [
              JSON.stringify(
                {
                  format: 'oxytocin.learnings.export',
                  schemaVersion: 1,
                  records: response.records,
                  history: response.history,
                },
                null,
                2,
              ),
            ],
            { type: 'application/json' },
          ),
        );
        const link = document.createElement('a');
        link.href = url;
        link.download = 'learnings.json';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } else {
        if (response.records[0]) choose(response.records[0]);
        else if (operation.action !== 'list') choose(null);
      }
      setResult(await request({ action: 'list', search, state: filter, offset }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const evidence = paths
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => draft.evidence.find((e) => e.path === path) ?? { path });
  const parsed = LearningDraftSchema.safeParse({ ...draft, evidence });
  const mutation = () => ({
    id: selected!.id,
    expectedRevision: selected!.revision,
    idempotencyKey: crypto.randomUUID(),
  });
  return (
    <Section title="Learnings">
      <p className="text-small text-fg-muted">
        Durable project findings, kept separately from the map. Accept a finding before agents reuse it. Matching
        evidence does not verify a claim. Unanchored findings need review after 30 days.
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          className={input}
          aria-label="Search learnings"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
          placeholder="Search learnings"
          maxLength={200}
        />
        <select
          className={input}
          aria-label="Learning state"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value as typeof filter);
            setOffset(0);
          }}
        >
          {(['all', 'proposed', 'accepted', 'needs-review', 'rejected', 'superseded'] as const).map((state) => (
            <option key={state}>{state}</option>
          ))}
        </select>
        <Button disabled={busy} onClick={() => void run({ action: 'list', search, state: filter, offset })}>
          Refresh learnings
        </Button>
        <Button onClick={() => choose(null)}>New learning</Button>
        <Button disabled={busy} onClick={() => void run({ action: 'export' })}>
          Export learnings
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
      <ul className="max-h-48 overflow-auto text-small" data-testid="learnings-list">
        {result?.records.map((record) => (
          <li key={record.id}>
            <button
              type="button"
              className="w-full rounded-control p-2 text-left hover:bg-hover"
              onClick={() => void run({ action: 'get', id: record.id })}
            >
              {record.title} · {record.review} · {record.applicability[projectId]?.state ?? 'awaiting review'} ·{' '}
              {record.origin.source} · revision {record.revision}
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button disabled={!offset || busy} onClick={() => setOffset(Math.max(0, offset - 100))}>
          Previous learnings
        </Button>
        <span className="text-small">{result?.total ?? 0} findings</span>
        <Button disabled={busy || offset + 100 >= (result?.total ?? 0)} onClick={() => setOffset(offset + 100)}>
          Next learnings
        </Button>
      </div>
      {selected && (
        <p className="text-small text-fg-muted">
          {selected.id} · {selected.scope} · {selected.origin.role ?? 'user'} · {selected.createdAt}
          {selected.applicability[projectId]?.reason ? ` · ${selected.applicability[projectId]?.reason}` : ''}
        </p>
      )}
      <Field label="Kind">
        <select
          aria-label="Learning kind"
          className={input}
          value={draft.kind}
          onChange={(e) => setDraft({ ...draft, kind: e.target.value as LearningDraft['kind'] })}
        >
          {['constraint', 'decision', 'pitfall', 'validation', 'failed-approach'].map((kind) => (
            <option key={kind}>{kind}</option>
          ))}
        </select>
      </Field>
      <Field label="Title">
        <input
          aria-label="Learning title"
          className={input}
          maxLength={160}
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
      </Field>
      <Field label="Finding">
        <textarea
          aria-label="Learning body"
          className={`${input} h-auto`}
          rows={3}
          maxLength={1500}
          value={draft.body}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
        />
      </Field>
      <Field label="Rationale">
        <textarea
          aria-label="Learning rationale"
          className={`${input} h-auto`}
          rows={2}
          maxLength={1200}
          value={draft.rationale}
          onChange={(e) => setDraft({ ...draft, rationale: e.target.value })}
        />
      </Field>
      <Field label="Topic" hint="Findings with the same topic require conflict resolution.">
        <input
          aria-label="Learning topic"
          className={input}
          maxLength={160}
          value={draft.topic ?? ''}
          onChange={(e) => setDraft({ ...draft, topic: e.target.value || undefined })}
        />
      </Field>
      <Field
        label="Evidence paths"
        hint="Up to eight project-relative indexed sources or named documents/configurations, one per line. Hashes are computed locally."
      >
        <textarea
          aria-label="Learning evidence"
          className={`${input} h-auto font-mono`}
          rows={2}
          value={paths}
          onChange={(e) => setPaths(e.target.value)}
        />
      </Field>
      <Field label="Replaces learning ID">
        <input
          aria-label="Replaces learning ID"
          className={input}
          value={draft.replaces ?? ''}
          onChange={(e) => setDraft({ ...draft, replaces: e.target.value || undefined })}
        />
      </Field>
      {selected?.evidence.map((e) => (
        <p className="break-all font-mono text-small text-fg-muted" key={e.path}>
          {e.path} · {e.hash}
        </p>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || !parsed.success}
          onClick={() => {
            if (parsed.success)
              void run({
                action: 'save',
                draft: parsed.data,
                ...(selected ? { id: selected.id } : {}),
                expectedRevision: selected?.revision ?? 0,
                idempotencyKey: crypto.randomUUID(),
              });
          }}
        >
          Save learning revision
        </Button>
        {selected && (
          <>
            <Button disabled={busy} onClick={() => void run({ action: 'review', ...mutation(), decision: 'accept' })}>
              Accept and revalidate
            </Button>
            <Button disabled={busy} onClick={() => void run({ action: 'review', ...mutation(), decision: 'reject' })}>
              Reject learning
            </Button>
            <Button disabled={busy} onClick={() => void run({ action: 'review', ...mutation(), decision: 'promote' })}>
              Promote to project
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                void confirmDialog({
                  title: 'Delete learning?',
                  description:
                    'This permanently removes the finding and its revisions from local storage and recovery copies. Existing exports cannot be erased.',
                  confirmLabel: 'Delete learning',
                  destructive: true,
                }).then((yes) => {
                  if (yes) void run({ action: 'delete', ...mutation() });
                });
              }}
            >
              Delete learning
            </Button>
          </>
        )}
      </div>
      {!!history.length && (
        <details>
          <summary className="text-small">Previous revisions ({history.length})</summary>
          {history.map((r) => (
            <p key={r.revision} className="text-small">
              Revision {r.revision} · {r.title} · {r.body}
            </p>
          ))}
        </details>
      )}
      <Button
        variant="danger"
        disabled={busy || !result?.total}
        onClick={() => {
          void confirmDialog({
            title: 'Forget all learnings?',
            description:
              'Permanently delete all findings and revision history in this checkout, including recovery copies. Map data is preserved. Existing exports cannot be erased.',
            confirmLabel: 'Forget all learnings',
            destructive: true,
          }).then((yes) => {
            if (yes && result)
              void run({
                action: 'forget',
                expectedRevision: result.memoryRevision,
                idempotencyKey: crypto.randomUUID(),
              });
          });
        }}
      >
        Forget all learnings
      </Button>
    </Section>
  );
}
