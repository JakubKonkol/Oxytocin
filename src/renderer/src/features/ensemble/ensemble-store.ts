import { create } from 'zustand';
import type { EnsembleRecord, EnsembleTask } from '@shared/domain/ensemble';
import type { EnsembleUserEvent } from '@shared/ipc/contract';
import { ipc } from '../../lib/ipc-client';
import { notify } from '../../ui/Toast';

export type EnsembleTab = 'flow' | 'agents' | 'activity' | 'changes' | 'artifacts' | 'task';

interface EnsembleStore {
  records: Record<string, EnsembleRecord>;
  loaded: boolean;
  /** Selected task per project. */
  selected: Record<string, string | null>;
  /** Tab per task. */
  tabs: Record<string, EnsembleTab>;
  /** Unsaved builder edits per task. */
  drafts: Record<string, EnsembleTask>;
  /** The agent shown in the peek drawer per task. */
  peek: Record<string, string | null>;
  load: () => Promise<void>;
  upsert: (record: EnsembleRecord) => void;
  remove: (taskId: string) => void;
  select: (projectId: string, taskId: string | null) => void;
  setTab: (taskId: string, tab: EnsembleTab) => void;
  setDraft: (task: EnsembleTask | null, taskId: string) => void;
  setPeek: (taskId: string, agentId: string | null) => void;
}

export const useEnsembleStore = create<EnsembleStore>((set, get) => ({
  records: {},
  loaded: false,
  selected: {},
  tabs: {},
  drafts: {},
  peek: {},
  async load() {
    const list = await ipc.invoke('ensemble:list', {});
    set({ records: Object.fromEntries(list.map((r) => [r.task.id, r])), loaded: true });
  },
  upsert(record) {
    set({ records: { ...get().records, [record.task.id]: record } });
  },
  remove(taskId) {
    const { [taskId]: _gone, ...records } = get().records;
    const { [taskId]: _draft, ...drafts } = get().drafts;
    const selected = Object.fromEntries(Object.entries(get().selected).map(([p, t]) => [p, t === taskId ? null : t]));
    set({ records, drafts, selected });
  },
  select(projectId, taskId) {
    set({ selected: { ...get().selected, [projectId]: taskId } });
  },
  setTab(taskId, tab) {
    set({ tabs: { ...get().tabs, [taskId]: tab } });
  },
  setDraft(task, taskId) {
    const drafts = { ...get().drafts };
    if (task) drafts[taskId] = task;
    else delete drafts[taskId];
    set({ drafts });
  },
  setPeek(taskId, agentId) {
    set({ peek: { ...get().peek, [taskId]: agentId } });
  },
}));

let subscribed = false;
export function subscribeEnsemble(): void {
  if (subscribed) return;
  subscribed = true;
  ipc.on('ensemble:changed', (record) => useEnsembleStore.getState().upsert(record));
  ipc.on('ensemble:removed', ({ taskId }) => useEnsembleStore.getState().remove(taskId));
  void useEnsembleStore
    .getState()
    .load()
    .catch(() => undefined);
}

export const projectRecords = (records: Record<string, EnsembleRecord>, projectId: string): EnsembleRecord[] =>
  Object.values(records)
    .filter((r) => r.task.projectId === projectId)
    .sort((a, b) => b.task.updatedAt - a.task.updatedAt);

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Sends a user event to a task's conductor; errors become a toast. Returns whether it was accepted. */
export async function ensembleCommand(taskId: string, event: EnsembleUserEvent): Promise<boolean> {
  try {
    const r = await ipc.invoke('ensemble:command', { taskId, event });
    if (r.error) {
      notify(
        'error',
        r.error.length > 120 ? 'Ensemble cannot do that now' : r.error,
        r.error.length > 120 ? { description: r.error } : {},
      );
      return false;
    }
    return true;
  } catch (e) {
    notify('error', 'Ensemble command failed', { description: message(e) });
    return false;
  }
}

/** Saves a builder draft; returns the stored record (null on error, with a toast). */
export async function saveTask(task: EnsembleTask): Promise<EnsembleRecord | null> {
  try {
    const record = await ipc.invoke('ensemble:save', { task });
    const store = useEnsembleStore.getState();
    store.upsert(record);
    // Edits made while saving stay as the draft.
    if (store.drafts[task.id] === task) store.setDraft(null, task.id);
    return record;
  } catch (e) {
    notify('error', 'The task could not be saved', { description: message(e) });
    return null;
  }
}

export async function createTask(
  projectId: string,
  templateId: string,
  o: { title?: string; description?: string } = {},
): Promise<EnsembleRecord | null> {
  try {
    const record = await ipc.invoke('ensemble:create', { projectId, templateId, ...o });
    const store = useEnsembleStore.getState();
    store.upsert(record);
    store.select(projectId, record.task.id);
    store.setTab(record.task.id, 'task');
    return record;
  } catch (e) {
    notify('error', 'The task could not be created', { description: message(e) });
    return null;
  }
}
