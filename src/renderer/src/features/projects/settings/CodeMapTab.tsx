import { useEffect, useState } from 'react';
import {
  CODE_MAP_MCP_INSTRUCTIONS,
  CodeMapSettingsSchema,
  type CodeMapDiagnostics,
  type CodeMapStatus,
} from '@shared/domain/code-map';
import type { Project } from '@shared/domain/project';
import { ipc } from '../../../lib/ipc-client';
import { useProjectsStore } from '../../../stores/projects-store';
import { confirmDialog, confirmDialogEx } from '../../../stores/dialog-store';
import { Button } from '../../../ui/Button';
import { openFile } from '../../editor/editor-actions';
import { workspaceFor } from '../../attention/reveal';
import { Check, Field, Section, input } from './controls';
import { useMcpStore } from '../../agent-tools/mcp-store';
import { useSettingsStore } from '../../../stores/settings-store';
import { executeCommand } from '../../../lib/commands';
import { usePluginsStore } from '../../../stores/plugins-store';

export const CODE_MAP_STATE_LABELS: Record<CodeMapStatus['state'], string> = {
  disabled: 'Disabled',
  indexing: 'Indexing',
  ready: 'Ready',
  updating: 'Updating',
  paused: 'Paused',
  degraded: 'Partial coverage',
  error: 'Error',
  limit: 'Limit reached — add exclusions',
};

/** Commands apply immediately; the rest of the settings dialog keeps its own draft. */
export function CodeMapTab({ project, close }: { project: Project; close: () => void }) {
  const visualizer = usePluginsStore((s) => s.contributions.commands.some((c) => c.id === 'codeMap.open'));
  const mcp = useMcpStore((s) => s.state?.status);
  const mcpEnabled = useSettingsStore((s) => s.settings?.['mcp.enabled']);
  const status = useProjectsStore((s) => s.codeMaps[project.id]);
  const settings = CodeMapSettingsSchema.parse(project.settings.codeMap ?? {});
  const savedExclusions = settings.excludedPaths.join('\n');
  const [exclusionDraft, setExclusions] = useState({ saved: savedExclusions, value: savedExclusions });
  if (exclusionDraft.saved !== savedExclusions) setExclusions({ saved: savedExclusions, value: savedExclusions });
  const exclusions = exclusionDraft.saved === savedExclusions ? exclusionDraft.value : savedExclusions;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<CodeMapDiagnostics | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void useMcpStore
      .getState()
      .load()
      .catch(() => undefined);
    void ipc
      .invoke('codeMap:getStatus', { projectId: project.id })
      .then((status) => {
        if (!cancelled) useProjectsStore.setState((s) => ({ codeMaps: { ...s.codeMaps, [project.id]: status } }));
      })
      .catch((e: unknown) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [project.id]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const enable = () =>
    run(async () => {
      if (settings.enabled) {
        await ipc.invoke('codeMap:setEnabled', { projectId: project.id, enabled: false });
        return;
      }
      const answer = await confirmDialogEx({
        title: 'Enable Code Map?',
        description:
          'Oxytocin will create .oxy/ in this project and build a local map in the background while the app runs. It stores file paths, declarations and relationships. No AI, network requests or project scripts are used. TypeScript, JavaScript and C# get declarations and relationships; other languages currently have file coverage only. You can pause updates, rebuild or delete the map at any time.',
        confirmLabel: 'Enable Code Map',
        checkbox: { label: 'Keep .oxy out of Git', defaultChecked: true },
      });
      if (answer.confirmed)
        await ipc.invoke('codeMap:setEnabled', { projectId: project.id, enabled: true, ignoreInGit: answer.checked });
    });
  const ignored = (ignoreInGit: boolean) =>
    run(async () => {
      let removeGitignoreEntry = false;
      if (!ignoreInGit) {
        const answer = await confirmDialogEx({
          title: 'Include the map in Git?',
          description:
            'MAP.md and graph.json may expose project structure and symbol names. Cache, manifest and local learnings stay ignored. Existing ignore rules may still keep .oxy out of Git.',
          confirmLabel: 'Change Git preference',
          checkbox: { label: 'Remove the .gitignore block added by Oxytocin', defaultChecked: true },
        });
        if (!answer.confirmed) return;
        removeGitignoreEntry = answer.checked;
      }
      await ipc.invoke('codeMap:setOptions', {
        projectId: project.id,
        excludedPaths: settings.excludedPaths,
        ignoreInGit,
        removeGitignoreEntry,
      });
    });
  const excludedPaths = exclusions
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const validated = CodeMapSettingsSchema.safeParse({ ...settings, excludedPaths });
  const action = (name: 'pause' | 'resume' | 'rebuild') =>
    run(() => ipc.invoke(`codeMap:${name}`, { projectId: project.id }));
  const canWrite = settings.enabled && !busy && !status?.readOnly;
  return (
    <div className="flex flex-col gap-3" data-testid="code-map-tab">
      <Section title="Code Map">
        <Check checked={settings.enabled} disabled={busy} onChange={() => void enable()} testId="code-map-enabled">
          Enable Code Map
        </Check>
        <p className="text-small text-fg-muted">
          A local map in .oxy/code-map/. Updates apply immediately while Oxytocin runs. Read current source before
          editing; missing relationships do not prove that code is unused.
        </p>
        <Check
          checked={settings.ignoreInGit}
          disabled={!canWrite}
          onChange={(v) => void ignored(v)}
          testId="code-map-ignore-git"
        >
          Keep .oxy out of Git
        </Check>
        {status?.gitIgnored && <p className="text-small text-fg-muted">.oxy is ignored by your .gitignore.</p>}
        {(error || status?.error) && (
          <p role="alert" className="text-small text-danger">
            {error ?? status?.error}
          </p>
        )}
        {status?.readOnly && (
          <p className="text-small text-warning">
            Updated by another Oxytocin instance. This instance reads the last saved map.
          </p>
        )}
      </Section>
      <Section title="Status">
        <div role="status" data-testid="code-map-state" className="text-ui text-fg">
          {CODE_MAP_STATE_LABELS[status?.state ?? 'disabled']}
        </div>
        {status?.progress && (
          <>
            <progress
              aria-label="Indexing progress"
              value={status.progress.completed}
              max={Math.max(1, status.progress.total)}
              className="w-full"
            />
            <span className="text-small text-fg-muted">
              {status.progress.completed} / {status.progress.total} files
            </span>
          </>
        )}
        {status && (
          <>
            <p className="text-small text-fg-secondary">
              {status.counts.files} files · {status.counts.symbols} symbols · {status.counts.edges} relationships ·{' '}
              {(status.bytes / 1048576).toFixed(2)} MiB · generation {status.generation}
            </p>
            <p className="text-small text-fg-muted">
              {status.coverage.files.skipped} skipped · {status.coverage.files.failed} failed ·{' '}
              {status.coverage.files.unsupported} file only · {status.coverage.unresolved.imports} unresolved imports ·{' '}
              {status.coverage.unresolved.calls} unresolved calls · {status.pendingFiles} pending
            </p>
            {status.updatedAt && (
              <p className="text-small text-fg-muted">Last published: {new Date(status.updatedAt).toLocaleString()}</p>
            )}
            <ul className="text-small text-fg-secondary">
              {Object.entries(status.languages).map(([language, support]) => (
                <li key={language} title={support.description} data-testid={`code-map-language-${language}`}>
                  {language}: {support.level} ({status.coverage.byLanguage[language] ?? 0} files)
                  {support.level !== 'Files' && <span className="block text-fg-muted">{support.description}</span>}
                </li>
              ))}
            </ul>
            <p className="text-small text-fg-muted">
              Limits: {status.limits.files.toLocaleString()} files, {status.limits.symbols.toLocaleString()} symbols,{' '}
              {status.limits.edges.toLocaleString()} relationships, {status.limits.bytes / 1048576} MiB. Add exclusions
              when a limit is reached.
            </p>
          </>
        )}
        <p className="text-small text-fg-muted" data-testid="code-map-mcp-status">
          MCP tools:{' '}
          {!settings.enabled
            ? 'enable Code Map for this project.'
            : !mcpEnabled
              ? 'MCP server is disabled.'
              : mcp?.port != null
                ? 'available through the MCP server, subject to Agent Tools policies.'
                : 'MCP server is not running.'}
        </p>
        <Button
          onClick={() => {
            close();
            void executeCommand('oxytocin.mcp.openSettings');
          }}
        >
          Configure Agent Tools
        </Button>
        <div className="flex flex-wrap gap-2">
          {visualizer && (
            <Button
              onClick={() => {
                close();
                void ipc.invoke('plugins:executeCommand', { id: 'codeMap.open', args: [project.id] });
              }}
            >
              Open Code Map
            </Button>
          )}
          <Button disabled={!canWrite} onClick={() => void action(status?.state === 'paused' ? 'resume' : 'pause')}>
            {status?.state === 'paused' ? 'Resume updates' : 'Pause updates'}
          </Button>
          <Button disabled={!canWrite} onClick={() => void action('rebuild')}>
            Rebuild
          </Button>
          {(status?.state === 'indexing' || status?.state === 'updating') && (
            <Button disabled={!canWrite} onClick={() => void action('pause')}>
              Cancel build
            </Button>
          )}
          <Button
            disabled={busy || status?.readOnly}
            variant="danger"
            onClick={() =>
              void run(async () => {
                if (
                  await confirmDialog({
                    title: 'Delete map data?',
                    description:
                      'Code Map will be disabled and .oxy/code-map removed. Learnings and other .oxy data are preserved. The project .gitignore entry is left in place.',
                    confirmLabel: 'Delete map data',
                    destructive: true,
                  })
                )
                  await ipc.invoke('codeMap:deleteData', { projectId: project.id });
              })
            }
          >
            Delete map data
          </Button>
        </div>
      </Section>
      <Section title="Exclusions">
        <Field
          label="Excluded paths"
          hint="One project-relative glob per line, using forward slashes (for example generated/**). Built-in secret and generated-folder exclusions always apply."
        >
          <textarea
            rows={4}
            aria-label="Excluded paths"
            className={`${input} h-auto py-1 font-mono`}
            value={exclusions}
            onChange={(e) => setExclusions({ saved: savedExclusions, value: e.target.value })}
          />
        </Field>
        {!validated.success && <p className="text-small text-danger">{validated.error.issues[0]?.message}</p>}
        <Button
          disabled={
            busy ||
            status?.readOnly ||
            !validated.success ||
            JSON.stringify(excludedPaths) === JSON.stringify(settings.excludedPaths)
          }
          onClick={() =>
            void run(() =>
              ipc.invoke('codeMap:setOptions', {
                projectId: project.id,
                excludedPaths,
                ignoreInGit: settings.ignoreInGit,
              }),
            )
          }
        >
          Apply exclusions
        </Button>
      </Section>
      <Section title="Agents and diagnostics">
        <p className="text-small text-fg-muted">
          Add the Code Map guidance to an agent instruction file only when you choose. Existing content is preserved.
        </p>
        {(['CLAUDE.md', 'AGENTS.md'] as const).map((file) => (
          <div key={file} className="flex flex-wrap gap-2">
            <Button
              disabled={busy}
              onClick={() =>
                void run(() => ipc.invoke('codeMap:editInstructions', { projectId: project.id, file, action: 'add' }))
              }
            >
              Add to {file}
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void run(() =>
                  ipc.invoke('codeMap:editInstructions', { projectId: project.id, file, action: 'remove' }),
                )
              }
            >
              Remove from {file}
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() =>
              void run(async () => {
                await ipc.invoke('clipboard:writeText', { text: CODE_MAP_MCP_INSTRUCTIONS });
                setCopied(true);
              })
            }
          >
            {copied ? 'Instructions copied' : 'Copy agent instructions'}
          </Button>
          <Button
            disabled={!status?.generation}
            onClick={() =>
              void run(async () => {
                const api = await workspaceFor(project.id);
                if (!api) throw new Error('Project workspace is unavailable');
                openFile(project.id, '.oxy/code-map/MAP.md', { pinned: true, api });
                close();
              })
            }
          >
            Open MAP.md
          </Button>
          <Button
            disabled={busy || !settings.enabled}
            onClick={() =>
              void run(async () =>
                setDiagnostics(await ipc.invoke('codeMap:getDiagnostics', { projectId: project.id })),
              )
            }
          >
            Show diagnostics
          </Button>
        </div>
        {diagnostics && (
          <>
            <Button
              onClick={() =>
                void run(() => ipc.invoke('clipboard:writeText', { text: JSON.stringify(diagnostics, null, 2) }))
              }
            >
              Copy diagnostics
            </Button>
            <pre className="max-h-48 overflow-auto rounded-control bg-input p-2 text-small text-fg-secondary">
              {JSON.stringify(diagnostics, null, 2)}
            </pre>
            {diagnostics.truncated && (
              <p className="text-small text-warning">Diagnostics are limited to the first 200 entries per category.</p>
            )}
          </>
        )}
      </Section>
    </div>
  );
}
