/** Open code editor panels by panel id — for commands, closing with unsaved changes and E2E hooks. */
export interface CodeHandle {
  projectId: string;
  path: string;
  isDirty(): boolean;
  /** Saves; false when it failed or was cancelled. */
  save(): Promise<boolean>;
  text(): string | null;
  setText(text: string): void;
  revealLine(line: number, column?: number): void;
  revealInFiles(): void;
  focus(): void;
}

export const codeRegistry = new Map<string, CodeHandle>();
