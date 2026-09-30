import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { Dialog, Tabs } from 'radix-ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectResources } from '@shared/domain/project-resources';
import { create } from 'zustand';
import { PROJECT_COLOR_COUNT, type Project } from '@shared/domain/project';
import type { TerminalProfile } from '@shared/domain/terminal-profile';
import { cn } from '../../lib/cn';
import { registerCommand } from '../../lib/commands';
import { ipc } from '../../lib/ipc-client';
import { useProjectsStore } from '../../stores/projects-store';
import { Button } from '../../ui/Button';
import { IconButton } from '../../ui/IconButton';
import { notify } from '../../ui/Toast';
import { confirmDialog } from '../../stores/dialog-store';
import { ProjectAvatar } from './ProjectAvatar';
import { resourceProblems, secretChanges, type SecretEdits } from './resources-model';
import { Field, input, Section } from './settings/controls';
import { ApisTab } from './settings/ApisTab';
import { DatabasesTab } from './settings/DatabasesTab';
import { AgentsTab, LinksLogsTab, RelatedTab } from './settings/OtherTabs';
import {
  draftOf,
  type EnvRow,
  move,
  patchFromDraft,
  type ProjectDraft,
  type StartupRow,
  validateDraft,
} from './project-settings-model';

interface ProjectSettingsStore {
  projectId: string | null;
  open: (projectId: string) => void;
  close: () => void;
}

export const useProjectSettingsStore = create<ProjectSettingsStore>((set) => ({
  projectId: null,
  open: (projectId) => set({ projectId }),
  close: () => set({ projectId: null }),
}));

export function openProjectSettings(projectId: string): void {
  useProjectSettingsStore.getState().open(projectId);
}

export function registerProjectSettingsCommands(): void {
  registerCommand({
    id: 'projects.openSettings',
    title: 'Projects: Project Settings…',
    when: () => useProjectsStore.getState().activeId !== null,
    run: (id) => {
      const projectId = typeof id === 'string' ? id : useProjectsStore.getState().activeId;
      if (projectId) openProjectSettings(projectId);
    },
  });
}

function ProfileSelect({
  value,
  profiles,
  onChange,
  empty,
  testId,
}: {
  value: string;
  profiles: TerminalProfile[];
  onChange: (v: string) => void;
  empty: string;
  testId?: string;
}) {
  return (
    <select data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)} className={input}>
      <option value="">{empty}</option>
      {profiles.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
      {value && !profiles.some((p) => p.id === value) && <option value={value}>{value} (not found)</option>}
    </select>
  );
}

function EnvTable({ rows, onChange }: { rows: EnvRow[]; onChange: (rows: EnvRow[]) => void }) {
  const set = (i: number, patch: Partial<EnvRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-1" data-testid="project-env">
      {rows.length === 0 && <div className="text-small text-fg-muted">No variables.</div>}
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2" data-testid="project-env-row">
          <input
            aria-label="Variable name"
            value={row.key}
            placeholder="NAME"
            onChange={(e) => set(i, { key: e.target.value })}
            className={cn(input, 'w-44 flex-none font-mono')}
          />
          <input
            aria-label="Value"
            value={row.value}
            placeholder={row.unset ? '(removed from the environment)' : 'value'}
            disabled={row.unset}
            onChange={(e) => set(i, { value: e.target.value })}
            className={cn(input, 'font-mono')}
          />
          <label className="flex flex-none items-center gap-1 text-small text-fg-secondary" title="Remove the variable">
            <input type="checkbox" checked={row.unset} onChange={(e) => set(i, { unset: e.target.checked })} />
            Unset
          </label>
          <IconButton
            label="Delete"
            icon={<Trash2 size={12} />}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          />
        </div>
      ))}
    </div>
  );
}

function StartupList({
  rows,
  profiles,
  onChange,
}: {
  rows: StartupRow[];
  profiles: TerminalProfile[];
  onChange: (rows: StartupRow[]) => void;
}) {
  const [dragged, setDragged] = useState<number | null>(null);
  const set = (i: number, patch: Partial<StartupRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-1.5" data-testid="project-startup">
      {rows.length === 0 && (
        <div className="text-small text-fg-muted">
          None — a new workspace opens one terminal with the default profile.
        </div>
      )}
      {rows.map((row, i) => (
        <div
          key={i}
          data-testid="project-startup-row"
          draggable
          onDragStart={(e) => {
            setDragged(i);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (dragged !== null && dragged !== i) onChange(move(rows, dragged, i));
            setDragged(null);
          }}
          className={cn(
            'grid grid-cols-[16px_1fr_1fr_1.5fr_1fr_90px_24px] items-center gap-1.5 rounded-control',
            dragged === i && 'opacity-50',
          )}
        >
          <GripVertical size={12} className="cursor-grab text-fg-muted" aria-label="Drag to reorder" />
          <input
            aria-label="Name"
            value={row.name}
            placeholder="Name"
            onChange={(e) => set(i, { name: e.target.value })}
            className={input}
          />
          <ProfileSelect
            value={row.profileId}
            profiles={profiles}
            empty="Default profile"
            onChange={(v) => set(i, { profileId: v })}
          />
          <input
            aria-label="Command"
            value={row.command}
            placeholder="Command (e.g. npm run dev)"
            onChange={(e) => set(i, { command: e.target.value })}
            className={cn(input, 'font-mono')}
          />
          <input
            aria-label="Folder"
            value={row.cwd}
            placeholder="Folder (relative)"
            onChange={(e) => set(i, { cwd: e.target.value })}
            className={cn(input, 'font-mono')}
          />
          <select
            aria-label="Placement"
            value={row.placement}
            onChange={(e) => set(i, { placement: e.target.value as StartupRow['placement'] })}
            className={input}
          >
            <option value="tab">Tab</option>
            <option value="right">Right</option>
            <option value="below">Below</option>
          </select>
          <IconButton
            label="Delete"
            icon={<Trash2 size={12} />}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          />
        </div>
      ))}
    </div>
  );
}

type TabId = 'general' | 'terminals' | 'environment' | 'git' | 'databases' | 'apis' | 'links' | 'related' | 'agents';

const TABS: { id: TabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'terminals', label: 'Terminals' },
  { id: 'environment', label: 'Environment' },
  { id: 'git', label: 'Git' },
  { id: 'databases', label: 'Databases' },
  { id: 'apis', label: 'APIs' },
  { id: 'links', label: 'Links & logs' },
  { id: 'related', label: 'Related projects' },
  { id: 'agents', label: 'Agents' },
];

interface ResourcesState {
  resources: ProjectResources;
  initial: string;
  stored: string[];
  encrypted: boolean;
  backend: string;
  unreadable: boolean;
}

function useResources(projectId: string) {
  const [state, setState] = useState<ResourcesState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    ipc.invoke('resources:get', { projectId }).then(
      (r) =>
        setState({
          resources: r.resources,
          initial: JSON.stringify(r.resources),
          stored: r.secrets.stored,
          encrypted: r.secrets.encrypted,
          backend: r.secrets.backend,
          unreadable: r.unreadable,
        }),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [projectId]);
  useEffect(load, [load]);
  return { state, setState, error, reload: load };
}

function SettingsForm({
  project,
  onDone,
  registerClose,
}: {
  project: Project;
  onDone: () => void;
  registerClose: (fn: () => void) => void;
}) {
  const [draft, setDraft] = useState<ProjectDraft>(() => draftOf(project));
  const initialDraft = useMemo(() => JSON.stringify(draftOf(project)), [project]);
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<TabId>('general');
  const res = useResources(project.id);
  const [edits, setEdits] = useState<SecretEdits>({});
  useEffect(() => {
    let cancelled = false;
    void ipc.invoke('terminals:profiles').then((p) => !cancelled && setProfiles(p));
    return () => {
      cancelled = true;
    };
  }, []);
  const update = (patch: Partial<ProjectDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const updateResources = useCallback(
    (fn: (r: ProjectResources) => ProjectResources) =>
      res.setState((s) => (s ? { ...s, resources: fn(s.resources) } : s)),
    [res],
  );
  const resourcesDirty =
    !!res.state && (JSON.stringify(res.state.resources) !== res.state.initial || Object.keys(edits).length > 0);
  const dirty = JSON.stringify(draft) !== initialDraft || resourcesDirty;
  const problems = [...validateDraft(draft), ...(res.state ? resourceProblems(res.state.resources) : [])];
  const envChanged =
    JSON.stringify(project.settings.env ?? {}) !== JSON.stringify(patchFromDraft(project, draft).settings?.env ?? {});

  const close = useCallback(() => {
    if (!dirty) return onDone();
    void confirmDialog({
      title: 'Discard your changes?',
      description: 'The project settings have unsaved changes.',
      confirmLabel: 'Discard',
      destructive: true,
    }).then((ok) => ok && onDone());
  }, [dirty, onDone]);
  useEffect(() => registerClose(close), [close, registerClose]);

  const save = async () => {
    setSaving(true);
    try {
      if (JSON.stringify(draft) !== initialDraft) await ipc.invoke('projects:update', patchFromDraft(project, draft));
      if (res.state && resourcesDirty)
        await ipc.invoke('resources:save', {
          projectId: project.id,
          resources: res.state.resources,
          secrets: secretChanges(res.state.resources, edits),
        });
      onDone();
    } catch (e) {
      notify('error', 'Could not save the project settings', {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  };

  const preview = {
    name: draft.name || project.name,
    color: draft.color,
    ...(draft.icon.trim() ? { icon: { kind: 'emoji' as const, value: draft.icon.trim() } } : {}),
  };
  const resourceProps = res.state
    ? {
        projectId: project.id,
        resources: res.state.resources,
        update: updateResources,
        stored: res.state.stored,
        edits,
        setEdits,
      }
    : null;
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (problems.length === 0) void save();
      }}
    >
      <Tabs.Root
        value={tab}
        onValueChange={(v) => setTab(v as TabId)}
        orientation="vertical"
        className="flex min-h-0 flex-1 gap-3 px-4 pb-3"
      >
        <Tabs.List
          aria-label="Project settings"
          className="flex w-40 flex-none flex-col gap-0.5 border-r border-line-subtle pr-2"
        >
          {TABS.map((t) => (
            <Tabs.Trigger
              key={t.id}
              value={t.id}
              data-testid={`project-settings-tab-${t.id}`}
              className="rounded-control px-2 py-1 text-left text-ui text-fg-secondary hover:bg-card-hover data-[state=active]:bg-focus-tint data-[state=active]:text-fg"
            >
              {t.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
          <Tabs.Content value="general" className="flex flex-col gap-3 outline-none">
            <div className="grid grid-cols-[1fr_auto] items-end gap-3">
              <Field label="Name">
                <input
                  data-testid="project-settings-name"
                  value={draft.name}
                  onChange={(e) => update({ name: e.target.value })}
                  className={input}
                />
              </Field>
              <Field label="Icon">
                <div className="flex items-center gap-2">
                  <ProjectAvatar project={preview} size={22} />
                  <input
                    data-testid="project-settings-icon"
                    aria-label="Icon"
                    value={draft.icon}
                    placeholder={project.name.charAt(0).toUpperCase()}
                    maxLength={8}
                    onChange={(e) => update({ icon: e.target.value })}
                    className={cn(input, 'w-16 text-center')}
                  />
                </div>
              </Field>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-small font-medium text-fg-secondary">Color</span>
              <div className="flex gap-1.5" role="radiogroup" aria-label="Color">
                {Array.from({ length: PROJECT_COLOR_COUNT }, (_, i) => (
                  <button
                    key={i}
                    type="button"
                    role="radio"
                    aria-checked={draft.color === i}
                    aria-label={`Color ${i + 1}`}
                    data-testid={`project-color-${i}`}
                    onClick={() => update({ color: i })}
                    className={cn(
                      'size-6 rounded-badge border-2',
                      draft.color === i ? 'border-fg' : 'border-transparent',
                    )}
                    style={{ background: `var(--project-${i})` }}
                  />
                ))}
              </div>
            </div>
            <Field label="Default terminal profile" hint="Used for new terminals of this project.">
              <ProfileSelect
                testId="project-settings-profile"
                value={draft.defaultProfileId}
                profiles={profiles}
                empty="Use the app default"
                onChange={(v) => update({ defaultProfileId: v })}
              />
            </Field>
            <Field
              label="Editor command"
              hint="Overrides the app editor for this project. Placeholders: ${file}, ${line}, ${column}, ${projectRoot}."
            >
              <input
                data-testid="project-settings-editor"
                value={draft.editorCommand}
                placeholder="e.g. code --goto ${file}:${line}:${column}"
                onChange={(e) => update({ editorCommand: e.target.value })}
                className={cn(input, 'font-mono')}
              />
            </Field>
          </Tabs.Content>

          <Tabs.Content value="terminals" className="flex flex-col gap-2 outline-none">
            <Section
              title="Startup terminals"
              action={
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    update({
                      startup: [...draft.startup, { name: '', profileId: '', command: '', cwd: '', placement: 'tab' }],
                    })
                  }
                >
                  <Plus size={12} /> Add terminal
                </Button>
              }
            >
              <StartupList rows={draft.startup} profiles={profiles} onChange={(startup) => update({ startup })} />
              <span className="text-small text-fg-muted">
                Opened when the project has no saved layout. Drag to reorder.
              </span>
            </Section>
          </Tabs.Content>

          <Tabs.Content value="environment" className="flex flex-col gap-2 outline-none">
            <Section
              title="Environment variables"
              action={
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => update({ env: [...draft.env, { key: '', value: '', unset: false }] })}
                >
                  <Plus size={12} /> Add variable
                </Button>
              }
            >
              <EnvTable rows={draft.env} onChange={(env) => update({ env })} />
              {envChanged && (
                <span className="text-small text-fg-muted" data-testid="project-env-note">
                  Applies to new terminals; running ones are marked as out of date (⟳).
                </span>
              )}
            </Section>
          </Tabs.Content>

          <Tabs.Content value="git" className="flex flex-col gap-3 outline-none">
            <label className="flex items-center gap-2 text-fg-secondary">
              <input
                type="checkbox"
                data-testid="project-settings-git"
                checked={draft.gitEnabled}
                onChange={(e) => update({ gitEnabled: e.target.checked })}
              />
              Show Git changes for this project
            </label>
            <Field label="Folders ignored by the file watcher" hint="One per line, in addition to the app setting.">
              <textarea
                data-testid="project-settings-ignored"
                rows={3}
                value={draft.ignoredFolders}
                onChange={(e) => update({ ignoredFolders: e.target.value })}
                className={cn(input, 'h-auto py-1 font-mono text-small')}
              />
            </Field>
          </Tabs.Content>

          {(['databases', 'apis', 'links', 'related', 'agents'] as const).map((id) => (
            <Tabs.Content key={id} value={id} className="flex min-h-0 flex-1 flex-col gap-2 outline-none">
              {res.error && <div className="text-small text-danger">{res.error}</div>}
              {!resourceProps && !res.error && <div className="text-small text-fg-muted">Loading…</div>}
              {resourceProps && res.state && (
                <>
                  {res.state.unreadable && (
                    <div className="rounded-control border border-warning px-2 py-1 text-small text-fg">
                      These resources were saved by a newer version of Oxytocin; saving here replaces them.
                    </div>
                  )}
                  {!res.state.encrypted && (id === 'databases' || id === 'apis') && (
                    <div
                      className="rounded-control border border-warning px-2 py-1 text-small text-fg"
                      data-testid="secrets-warning"
                    >
                      {res.state.backend === 'basic_text'
                        ? 'No keyring was found (libsecret or KWallet): secrets are only obfuscated, not encrypted.'
                        : 'The operating system cannot encrypt secrets right now: passwords cannot be saved.'}
                    </div>
                  )}
                  {id === 'databases' && <DatabasesTab {...resourceProps} />}
                  {id === 'apis' && <ApisTab {...resourceProps} />}
                  {id === 'links' && <LinksLogsTab {...resourceProps} />}
                  {id === 'related' && <RelatedTab {...resourceProps} />}
                  {id === 'agents' && (
                    <AgentsTab
                      {...resourceProps}
                      dirty={resourcesDirty}
                      reload={() => {
                        setEdits({});
                        res.reload();
                      }}
                    />
                  )}
                </>
              )}
            </Tabs.Content>
          ))}
        </div>
      </Tabs.Root>
      {problems.length > 0 && (
        <div
          className="max-h-24 overflow-auto border-t border-line-subtle px-4 py-2 text-small text-danger"
          data-testid="project-settings-problems"
        >
          {problems.map((p) => (
            <div key={p}>{p}</div>
          ))}
        </div>
      )}
      <div className="flex justify-end gap-2 border-t border-line-subtle px-4 py-3">
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          data-testid="project-settings-save"
          disabled={saving || problems.length > 0}
        >
          Save
        </Button>
      </div>
    </form>
  );
}

/** Project settings dialog. */
export function ProjectSettingsDialog() {
  const projectId = useProjectSettingsStore((s) => s.projectId);
  const close = useProjectSettingsStore((s) => s.close);
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const requestClose = useRef<() => void>(close);
  const registerClose = useCallback((fn: () => void) => {
    requestClose.current = fn;
  }, []);
  if (!projectId || !project) return null;
  return (
    <Dialog.Root open onOpenChange={(o) => !o && requestClose.current()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-app/60" />
        <Dialog.Content
          data-testid="project-settings"
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            requestClose.current();
          }}
          onPointerDownOutside={(e) => e.preventDefault()}
          className="fixed top-[5vh] left-1/2 z-50 flex h-[90vh] max-h-[760px] w-[880px] max-w-[90vw] -translate-x-1/2 flex-col rounded-card border border-line bg-elevated shadow-elevated"
        >
          <Dialog.Title className="px-4 pt-4 pb-3 text-ui font-medium text-fg">
            Project settings · <span className="text-fg-secondary">{project.rootPath}</span>
          </Dialog.Title>
          <SettingsForm key={project.id} project={project} onDone={close} registerClose={registerClose} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
