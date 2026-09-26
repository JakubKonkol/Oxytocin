/** Live diff editors by panel id — for commands (F7) and E2E hooks. */
export interface DiffHandle {
  goToChange(direction: 'next' | 'previous'): void;
  text(): { original: string; modified: string };
  changeCount(): number;
  /** 1-based line in the modified file of the current (or first) change. */
  currentLine(): number | undefined;
}

export const diffRegistry = new Map<string, DiffHandle>();
