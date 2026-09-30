import { ExternalLink, FileText, Link2, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { McpCallLogEntry } from '@shared/domain/mcp';
import { type INSTRUCTIONS_FILES, newResourceId, type ProjectResources } from '@shared/domain/project-resources';
import { cn } from '../../../lib/cn';
import { ipc } from '../../../lib/ipc-client';
import { useProjectsStore } from '../../../stores/projects-store';
import { Button } from '../../../ui/Button';
import { IconButton } from '../../../ui/IconButton';
import { notify } from '../../../ui/Toast';
import { useMcpStore } from '../../agent-tools/mcp-store';
import { Check, Field, input, Section } from './controls';

interface TabProps {
  projectId: string;
  resources: ProjectResources;
  update: (fn: (r: ProjectResources) => ProjectResources) => void;
}

const ids = (r: ProjectResources) => [...r.databases, ...r.apis, ...r.links, ...r.logs].map((x) => x.id);

/** Project settings → Links & logs. */
export function LinksLogsTab({ projectId, resources, update }: TabProps) {
  const setLink = (id: string, patch: Partial<ProjectResources['links'][number]>) =>
    update((r) => ({ ...r, links: r.links.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));
  const setLog = (id: string, patch: Partial<ProjectResources['logs'][number]>) =>
    update((r) => ({ ...r, logs: r.logs.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));
  return (
    <div className="flex flex-col gap-3" data-testid="tab-links">
      <Section
        title="Links"
        action={
          <Button
            size="sm"
            variant="ghost"
            data-testid="link-add"
            onClick={() =>
              update((r) => ({
                ...r,
                links: [...r.links, { id: newResourceId(ids(r), 'link'), title: 'Tracker', url: 'https://' }],
              }))
            }
          >
            <Plus size={12} /> Add link
          </Button>
        }
      >
        <p className="text-small text-fg-muted">
          Tracker, designs, staging, docs: shown in the project's context menu and told to agents.
        </p>
        {resources.links.map((l) => (
          <div key={l.id} data-testid="link-row" className="grid grid-cols-[16px_1fr_2fr_24px] items-center gap-2">
            <Link2 size={12} className="text-fg-muted" />
            <input
              aria-label="Title"
              value={l.title}
              onChange={(e) => setLink(l.id, { title: e.target.value })}
              className={input}
            />
            <input
              aria-label="URL"
              value={l.url}
              onChange={(e) => setLink(l.id, { url: e.target.value })}
              className={cn(input, 'font-mono')}
            />
            <IconButton
              label="Delete"
              icon={<Trash2 size={12} />}
              onClick={() => update((r) => ({ ...r, links: r.links.filter((x) => x.id !== l.id) }))}
            />
          </div>
        ))}
      </Section>
      <Section
        title="Log files"
        action={
          <Button
            size="sm"
            variant="ghost"
            data-testid="log-add"
            onClick={() =>
              update((r) => ({
                ...r,
                logs: [
                  ...r.logs,
                  {
                    id: newResourceId(ids(r), 'log'),
                    name: `log-${r.logs.length + 1}`,
                    path: 'logs/*.log',
                    agents: { exposed: true, shareWithRelated: false },
                  },
                ],
              }))
            }
          >
            <Plus size={12} /> Add log file
          </Button>
        }
      >
        <p className="text-small text-fg-muted">
          A file or a pattern in the file name (<span className="font-mono">C:\logs\api-*.log</span>: the newest match),
          inside or outside the project. Agents read the end with oxy_logs_tail.
        </p>
        {resources.logs.map((l) => (
          <div
            key={l.id}
            data-testid="log-row"
            className="grid grid-cols-[16px_1fr_2fr_auto_auto_24px] items-center gap-2"
          >
            <FileText size={12} className="text-fg-muted" />
            <input
              aria-label="Name"
              value={l.name}
              onChange={(e) => setLog(l.id, { name: e.target.value })}
              className={input}
            />
            <input
              aria-label="Path"
              value={l.path}
              onChange={(e) => setLog(l.id, { path: e.target.value })}
              className={cn(input, 'font-mono')}
            />
            <Button
              size="sm"
              onClick={() =>
                void ipc
                  .invoke('resources:pickFile', { projectId, purpose: 'log' })
                  .then((p) => p && setLog(l.id, { path: p }))
              }
            >
              …
            </Button>
            <Check checked={l.agents.exposed} onChange={(v) => setLog(l.id, { agents: { ...l.agents, exposed: v } })}>
              Agents
            </Check>
            <IconButton
              label="Delete"
              icon={<Trash2 size={12} />}
              onClick={() => update((r) => ({ ...r, logs: r.logs.filter((x) => x.id !== l.id) }))}
            />
          </div>
        ))}
      </Section>
    </div>
  );
}

/** Project settings → Related projects. */
export function RelatedTab({ projectId, resources, update }: TabProps) {
  const projects = useProjectsStore((s) => s.projects).filter((p) => p.id !== projectId);
  const related = new Set(resources.relatedProjectIds);
  const roots = projects.filter((p) => related.has(p.id));
  return (
    <div className="flex flex-col gap-3" data-testid="tab-related">
      <Section title="Related projects">
        <p className="text-small text-fg-muted">
          Agents of this project may use the resources a related project marks <em>Share with related projects</em> (and
          the other way round: the link is kept on both sides).
        </p>
        {projects.length === 0 && <p className="text-small text-fg-muted">No other projects.</p>}
        {projects.map((p) => (
          <Check
            key={p.id}
            testId={`related-${p.name}`}
            checked={related.has(p.id)}
            onChange={(v) =>
              update((r) => ({
                ...r,
                relatedProjectIds: v ? [...r.relatedProjectIds, p.id] : r.relatedProjectIds.filter((id) => id !== p.id),
              }))
            }
          >
            {p.name} <span className="text-small text-fg-muted">{p.rootPath}</span>
          </Check>
        ))}
      </Section>
      {roots.length > 0 && (
        <Section title="Claude Code">
          <p className="text-small text-fg-muted">
            To let Claude Code read the related projects' code too, start it with:
          </p>
          <pre
            className="overflow-auto rounded-control bg-input p-2 font-mono text-small text-fg select-text"
            data-testid="related-add-dir"
          >
            claude {roots.map((p) => `--add-dir "${p.rootPath}"`).join(' ')}
          </pre>
        </Section>
      )}
    </div>
  );
}

const shortTime = (at: number) => new Date(at).toLocaleTimeString();

/** Project settings → Agents: the brief, the instructions file and the project's recent tool calls. */
export function AgentsTab({
  projectId,
  resources,
  update,
  dirty,
  reload,
}: TabProps & { dirty: boolean; reload: () => void }) {
  const [brief, setBrief] = useState<string | null>(null);
  const [repositoryFile, setRepositoryFile] = useState(false);
  const log = useMcpStore((s) => s.state?.log ?? []).filter((e: McpCallLogEntry) => e.projectId === projectId);
  useEffect(() => {
    void useMcpStore.getState().load();
  }, []);
  useEffect(() => {
    let cancelled = false;
    void ipc.invoke('resources:brief', { projectId }).then((r) => !cancelled && setBrief(r.text));
    void ipc.invoke('resources:get', { projectId }).then((r) => !cancelled && setRepositoryFile(r.repositoryFile));
    return () => {
      cancelled = true;
    };
  }, [projectId, dirty]);
  const file = resources.agentBrief.instructionsFile;
  return (
    <div className="flex flex-col gap-3" data-testid="tab-agents">
      <Section title="How agents learn about the resources">
        <p className="text-small text-fg-muted">
          Agents connected to Oxytocin's MCP server see the resource tools and, when they run in this project, this
          brief.
        </p>
        <Check
          testId="agents-session-hook"
          checked={resources.agentBrief.sessionHook}
          onChange={(v) => update((r) => ({ ...r, agentBrief: { ...r.agentBrief, sessionHook: v } }))}
        >
          Give Claude Code sessions the brief with their first prompt (needs the Claude Code Bridge hooks)
        </Check>
        <Field label="Brief" hint={dirty ? 'Save to see the brief of your changes.' : undefined}>
          <pre
            data-testid="agents-brief"
            className="max-h-48 overflow-auto whitespace-pre-wrap rounded-control bg-input p-2 font-mono text-small text-fg select-text"
          >
            {brief === null ? '…' : brief || 'No resources for agents yet.'}
          </pre>
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-small text-fg-secondary">Also keep it in</span>
          <select
            data-testid="agents-instructions-file"
            value={file}
            disabled={dirty}
            onChange={(e) => {
              const next = e.target.value as (typeof INSTRUCTIONS_FILES)[number];
              void ipc
                .invoke('resources:writeInstructions', { projectId, file: next })
                .then((r) => {
                  reload();
                  notify('success', next === 'none' ? 'The block was removed' : `Written to ${next}`, {
                    ...(r.path ? { description: r.path } : {}),
                  });
                })
                .catch((err: unknown) =>
                  notify('error', 'Could not write the file', {
                    description: err instanceof Error ? err.message : String(err),
                  }),
                );
            }}
            className={cn(input, 'w-40')}
          >
            <option value="none">No file</option>
            <option value="AGENTS.md">AGENTS.md</option>
            <option value="CLAUDE.md">CLAUDE.md</option>
          </select>
          <span className="text-small text-fg-muted">
            A managed block, kept up to date; never secrets or production hosts.
          </span>
        </div>
      </Section>
      <Section title="Share with the team">
        <p className="text-small text-fg-muted">
          Write the resources (without secrets and without production resources) to{' '}
          <span className="font-mono">.oxytocin/project.json</span>. Others are asked before Oxytocin uses them.
          {repositoryFile ? ' The file exists.' : ''}
        </p>
        <div>
          <Button
            size="sm"
            data-testid="agents-save-repository"
            disabled={dirty}
            onClick={() =>
              void ipc
                .invoke('resources:saveToRepository', { projectId })
                .then((r) => {
                  setRepositoryFile(true);
                  notify('success', 'Saved to the repository', { description: r.path });
                })
                .catch((err: unknown) =>
                  notify('error', 'Could not write the file', {
                    description: err instanceof Error ? err.message : String(err),
                  }),
                )
            }
          >
            <ExternalLink size={12} /> Save to repository
          </Button>
        </div>
      </Section>
      <Section title="Recent tool calls in this project">
        {log.length === 0 ? (
          <p className="text-small text-fg-muted">
            No calls yet. Queries and request lines are kept (not their results) until you clear them in Settings →
            Agent Tools.
          </p>
        ) : (
          <div className="max-h-56 overflow-auto" data-testid="agents-log">
            {log.map((e) => (
              <div
                key={e.id}
                data-testid="agents-log-row"
                data-tool={e.tool}
                className="flex items-center gap-2 border-b border-line-subtle py-1 text-small last:border-b-0"
                title={e.error}
              >
                <span className="w-16 flex-none font-mono text-fg-muted">{shortTime(e.at)}</span>
                <span className="w-36 flex-none truncate font-mono text-fg">{e.tool}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-fg-secondary">
                  {e.detail ?? e.caller ?? ''}
                </span>
                <span
                  className={cn(
                    'flex-none',
                    e.outcome === 'ok' ? 'text-success' : e.outcome === 'denied' ? 'text-warning' : 'text-danger',
                  )}
                >
                  {e.outcome}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
