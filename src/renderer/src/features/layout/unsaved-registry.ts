/** Panels with edits that are not saved yet (code editors, edited diffs) — asked about before they close. */
export interface UnsavedPanel {
  projectId: string;
  /** File name shown in the question. */
  name: string;
  isDirty(): boolean;
  /** Saves; false when saving failed. */
  save(): Promise<boolean>;
}

export const unsavedRegistry = new Map<string, UnsavedPanel>();

/** Whether a project's workspace has panels with unsaved edits (it must stay mounted). */
export function hasUnsavedEdits(projectId: string): boolean {
  return [...unsavedRegistry.values()].some((p) => p.projectId === projectId && p.isDirty());
}

/** Names of the files with unsaved edits in any open panel. */
export function unsavedFiles(): string[] {
  return [...unsavedRegistry.values()].filter((p) => p.isDirty()).map((p) => p.name);
}

/** Saves every panel with unsaved edits; false when one of them could not be saved. */
export async function saveAllUnsaved(): Promise<boolean> {
  const results = await Promise.all([...unsavedRegistry.values()].filter((p) => p.isDirty()).map((p) => p.save()));
  return results.every(Boolean);
}
