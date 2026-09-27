import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { type ReactNode, useEffect, useState } from 'react';
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
import { ProjectAvatar } from './ProjectAvatar';
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

const input = 'h-7 w-full rounded-control border border-line bg-input px-2 text-ui text-fg placeholder:text-fg-muted';

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-small font-medium text-fg-secondary">{label}</span>
      {children}
      {hint && <span className="text-small text-fg-muted">{hint}</span>}
    </label>
  );
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-line-subtle pt-3">
      <div className="flex items-center">
        <h3 className="oxy-label flex-1">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
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

function SettingsForm({ project, onDone }: { project: Project; onDone: () => void }) {
  const [draft, setDraft] = useState<ProjectDraft>(() => draftOf(project));
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void ipc.invoke('terminals:profiles').then((p) => !cancelled && setProfiles(p));
    return () => {
      cancelled = true;
    };
  }, []);
  const update = (patch: Partial<ProjectDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const problems = validateDraft(draft);
  const envChanged =
    JSON.stringify(project.settings.env ?? {}) !== JSON.stringify(patchFromDraft(project, draft).settings?.env ?? {});

  const save = async () => {
    setSaving(true);
    try {
      await ipc.invoke('projects:update', patchFromDraft(project, draft));
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
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (problems.length === 0) void save();
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 pb-3">
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
                className={cn('size-6 rounded-badge border-2', draft.color === i ? 'border-fg' : 'border-transparent')}
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

        <Section title="Editor and Git">
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
        </Section>
      </div>
      {problems.length > 0 && (
        <div
          className="border-t border-line-subtle px-4 py-2 text-small text-danger"
          data-testid="project-settings-problems"
        >
          {problems.map((p) => (
            <div key={p}>{p}</div>
          ))}
        </div>
      )}
      <div className="flex justify-end gap-2 border-t border-line-subtle px-4 py-3">
        <Button variant="ghost" onClick={onDone}>
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

/** Project settings dialog (docs/plan/03-projects-workspace.md §8, roadmap M7-T7). */
export function ProjectSettingsDialog() {
  const projectId = useProjectSettingsStore((s) => s.projectId);
  const close = useProjectSettingsStore((s) => s.close);
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  if (!projectId || !project) return null;
  return (
    <Dialog.Root open onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-app/60" />
        <Dialog.Content
          data-testid="project-settings"
          aria-describedby={undefined}
          className="fixed top-12 left-1/2 z-50 flex max-h-[calc(100vh-96px)] w-[760px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col rounded-card border border-line bg-elevated shadow-elevated"
        >
          <Dialog.Title className="px-4 pt-4 pb-3 text-ui font-medium text-fg">
            Project settings · <span className="text-fg-secondary">{project.rootPath}</span>
          </Dialog.Title>
          <SettingsForm key={project.id} project={project} onDone={close} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
