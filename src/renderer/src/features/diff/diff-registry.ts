/** Live diff editors by panel id — for commands (F7), saving edits and E2E hooks. */
export interface DiffHandle {
  goToChange(direction: 'next' | 'previous'): void;
  text(): { original: string; modified: string };
  changeCount(): number;
  /** 1-based line in the modified file of the current (or first) change. */
  currentLine(): number | undefined;
  /** The edited right side (null before the content loaded). */
  modifiedValue(): string | null;
  /** Captures the exact model version being saved, preserving edits made during the write. */
  captureSave(): { text: string; markSaved(): boolean } | null;
  /** Drops unsaved edits and shows the file as it is on disk. */
  discardEdits(): void;
  revealLine(line: number): void;
  focus(): void;
}

export const diffRegistry = new Map<string, DiffHandle>();
